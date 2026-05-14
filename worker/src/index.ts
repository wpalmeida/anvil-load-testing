import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import postgres from 'postgres';
import { runK6 } from './runner.ts';
import { buildScript, buildBrowserScript } from './k6-script.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
if (!process.env.INFLUXDB_URL) throw new Error('INFLUXDB_URL is required');

// Column-only camel transform (avoid touching JSON values — see api/src/db.ts).
const sql = postgres(process.env.DATABASE_URL, {
  transform: { column: postgres.camel.column },
});
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new IORedis(process.env.REDIS_URL); // commands client (set/del)
const subscriber = new IORedis(process.env.REDIS_URL); // dedicated for SUBSCRIBE

const CANCEL_CHANNEL = 'run:cancel';
const ACTIVE_KEY = (id: string) => `run:active:${id}`;
const ACTIVE_TTL_SECONDS = 60 * 60 * 24; // 24h safety net

// In-memory registry of children owned by THIS worker process.
const active = new Map<string, ChildProcess>();

subscriber.subscribe(CANCEL_CHANNEL).catch((err) => {
  console.error('failed to subscribe to', CANCEL_CHANNEL, err);
  process.exit(1);
});

subscriber.on('message', (channel, runId) => {
  if (channel !== CANCEL_CHANNEL) return;
  const child = active.get(runId);
  if (!child) return; // not ours
  console.log(`[run ${runId}] cancel received, sending SIGTERM to pid ${child.pid}`);
  try {
    child.kill('SIGTERM');
  } catch (err) {
    console.error(`[run ${runId}] SIGTERM failed:`, err);
  }
  // escalate after grace period
  setTimeout(() => {
    if (active.has(runId)) {
      console.log(`[run ${runId}] still alive, sending SIGKILL`);
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, 10_000);
});

const worker = new Worker(
  'runs',
  async (job) => {
    const { runId } = job.data as { runId: string };
    console.log(`[run ${runId}] starting`);

    const [run] = await sql`SELECT * FROM runs WHERE id = ${runId}`;
    if (!run) throw new Error(`run ${runId} not found`);

    await sql`UPDATE runs SET status = 'running', started_at = now() WHERE id = ${runId}`;

    const execution = run.config.execution ?? {
      executor: 'constant-vus',
      vus: run.vus ?? 1,
      duration: run.duration ?? '30s',
    };
    const testType = run.config.testType ?? 'http';
    // Build auth headers up here so both script types and the worker's env
    // injection can share the value. Back-compat: older rows may have
    // authToken instead of authHeaders.
    const authHeaders: Record<string, string> = { ...(run.config.authHeaders ?? {}) };
    if (run.config.authToken && !authHeaders['Authorization']) {
      authHeaders['Authorization'] = `Bearer ${run.config.authToken}`;
    }
    const script =
      testType === 'browser'
        ? buildBrowserScript({
            runId,
            service: run.service,
            baseUrl: run.baseUrl,
            triggeredBy: run.triggeredBy ?? 'unknown',
            execution,
            steps: run.config.browserSteps ?? [],
            thresholds: run.config.thresholds ?? [],
            authHeaders,
          })
        : buildScript({
            runId,
            service: run.service,
            baseUrl: run.baseUrl,
            execution,
            operations: run.config.operations,
            triggeredBy: run.triggeredBy ?? 'unknown',
            thresholds: run.config.thresholds ?? [],
            setup: run.config.setup ?? [],
            teardown: run.config.teardown ?? [],
            datasets: run.config.datasets ?? [],
          });

    try {
      const { code, stderr, summary } = await runK6({
        script,
        influxUrl: process.env.INFLUXDB_URL!,
        env: {
          AUTH_HEADERS: JSON.stringify(authHeaders),
        },
        tags: {
          run_id: runId,
          service: run.service,
          triggered_by: run.triggeredBy ?? 'unknown',
        },
        onSpawn: async (child) => {
          active.set(runId, child);
          try {
            await redis.set(
              ACTIVE_KEY(runId),
              JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: Date.now() }),
              'EX',
              ACTIVE_TTL_SECONDS,
            );
          } catch (err) {
            console.warn(`[run ${runId}] failed to write active key:`, err);
          }
        },
      });

      console.log(`[run ${runId}] k6 exited with code ${code}`);
      if (stderr) console.error(`[run ${runId}] stderr tail:\n${stderr.slice(-1000)}`);

      await sql`
        UPDATE runs
        SET status = ${code === 0 ? 'completed' : 'failed'},
            finished_at = now(),
            summary = ${summary ? sql.json(summary as any) : null},
            error = ${formatRunError(code, stderr)}
        WHERE id = ${runId}
      `;
    } catch (err) {
      console.error(`[run ${runId}] failed:`, err);
      await sql`
        UPDATE runs
        SET status = 'failed', finished_at = now(), error = ${(err as Error).message}
        WHERE id = ${runId}
      `;
      throw err;
    } finally {
      active.delete(runId);
      try {
        await redis.del(ACTIVE_KEY(runId));
      } catch {}
    }
  },
  { connection, concurrency: 2 },
);

worker.on('failed', (job, err) => {
  console.error(`job ${job?.id} failed:`, err);
});

// k6 exit codes — see https://grafana.com/docs/k6/latest/error-codes/
function formatRunError(code: number, stderr: string): string | null {
  if (code === 0) return null;
  switch (code) {
    case 99:
      return 'Threshold breached — see the Thresholds panel for which one(s) failed.';
    case 103:
      return 'Threshold breached and test was aborted (abortOnFail).';
    case 102:
      return 'Test was canceled.';
    case 104:
      return 'Test aborted via test.abort().';
    default:
      return `k6 exited with code ${code}: ${stderr.slice(-2000)}`;
  }
}

console.log('worker listening on queue "runs"');
