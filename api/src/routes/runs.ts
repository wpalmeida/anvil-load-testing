import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.ts';
import { runQueue, redisPub, CANCEL_CHANNEL } from '../queue.ts';
import { buildGrafanaUrl } from '../lib/grafana.ts';
import { Profile, Stage, normalizeExecution, summarizeExecution } from '../lib/profiles.ts';
import { isHostAllowed, checkExecutionCaps, checkConcurrentRunCap } from '../lib/guards.ts';
import { parseDataset } from '../lib/datasets.ts';

const OperationConfig = z.object({
  method: z.enum(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']),
  path: z.string(),
  pathParams: z.record(z.any()).optional(),
  queryParams: z.record(z.any()).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

// k6 threshold expression like "p(95)<500" or "rate<0.01". The metric name
// the expression applies to is stored separately so the worker can group
// multiple expressions under the same metric in the k6 options block.
const ThresholdConfig = z.object({
  metric: z.string().min(1),
  expression: z.string().min(1),
  abortOnFail: z.boolean().optional(),
});

// One HTTP step run during k6's setup() or teardown(). `extract` pulls values
// out of the response into a shared context that operations can reference
// via {{name}} in headers and body.
const ExtractBinding = z.object({
  name: z.string().min(1),
  from: z.enum(['json', 'header', 'status']),
  path: z.string().optional(),
});

const SetupStep = z.object({
  name: z.string().optional(),
  method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  extract: z.array(ExtractBinding).optional(),
});

// User-supplied JSON or CSV. Server parses and stores as records on submit so
// the worker doesn't have to re-parse every run.
const DatasetInput = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message: 'dataset name must be a valid identifier (a-z, 0-9, _)',
  }),
  format: z.enum(['json', 'csv']),
  content: z.string().min(1).max(2_000_000),
});

const CreateRunBody = z.object({
  service: z.string().min(1),
  baseUrl: z.string().url(),
  triggeredBy: z.string().optional(),
  authHeaders: z.record(z.string()).optional(),
  authToken: z.string().optional(), // back-compat: → Authorization: Bearer
  profile: Profile,
  vus: z.number().int().positive().max(10000).optional(),
  duration: z.string().regex(/^\d+(ms|s|m|h)$/).optional(),
  stages: z.array(Stage).optional(),
  startVUs: z.number().int().min(0).max(10000).optional(),
  operations: z.array(OperationConfig).min(1),
  thresholds: z.array(ThresholdConfig).optional(),
  setup: z.array(SetupStep).optional(),
  teardown: z.array(SetupStep).optional(),
  datasets: z.array(DatasetInput).optional(),
});

export const runsRoute: FastifyPluginAsync = async (app) => {
  app.post('/runs', async (req, reply) => {
    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid body', details: parsed.error.flatten() };
    }
    const body = parsed.data;

    const hostGuard = isHostAllowed(body.baseUrl);
    if (!hostGuard.ok) {
      reply.code(403);
      return { error: hostGuard.reason };
    }

    let execution;
    try {
      execution = normalizeExecution(body);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }

    const capsGuard = checkExecutionCaps(execution);
    if (!capsGuard.ok) {
      reply.code(403);
      return { error: capsGuard.reason };
    }

    const concurrentGuard = await checkConcurrentRunCap();
    if (!concurrentGuard.ok) {
      reply.code(429);
      return { error: concurrentGuard.reason };
    }

    const { peakVUs, totalDuration } = summarizeExecution(execution);

    let datasets: Array<{ name: string; records: unknown[] }> = [];
    try {
      datasets = (body.datasets ?? []).map((d) => ({
        name: d.name,
        records: parseDataset(d.format, d.content),
      }));
    } catch (err) {
      reply.code(400);
      return { error: `dataset error: ${(err as Error).message}` };
    }

    const authHeaders = { ...(body.authHeaders ?? {}) };
    if (body.authToken && !authHeaders['Authorization']) {
      authHeaders['Authorization'] = `Bearer ${body.authToken}`;
    }

    const [row] = await sql`
      INSERT INTO runs (service, base_url, profile, vus, duration, config, triggered_by, status)
      VALUES (
        ${body.service},
        ${body.baseUrl},
        ${body.profile},
        ${peakVUs},
        ${totalDuration},
        ${sql.json({
          operations: body.operations,
          authHeaders,
          execution,
          thresholds: body.thresholds ?? [],
          setup: body.setup ?? [],
          teardown: body.teardown ?? [],
          datasets,
        } as any)},
        ${body.triggeredBy ?? null},
        'queued'
      )
      RETURNING id, queued_at
    `;

    await runQueue.add('run', { runId: row.id }, { jobId: row.id });

    return { id: row.id, status: 'queued', queuedAt: row.queuedAt };
  });

  app.get('/runs', async () => {
    const rows = await sql`
      SELECT id, service, base_url, profile, vus, duration, status,
             triggered_by, queued_at, started_at, finished_at
      FROM runs
      ORDER BY queued_at DESC
      LIMIT 100
    `;
    return { runs: rows };
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const [row] = await sql`SELECT * FROM runs WHERE id = ${req.params.id}`;
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    return {
      ...row,
      grafanaUrl: buildGrafanaUrl(row.id, row.startedAt, row.finishedAt, row.service),
    };
  });

  app.post<{ Params: { id: string } }>('/runs/:id/rerun', async (req, reply) => {
    const [original] = await sql`SELECT * FROM runs WHERE id = ${req.params.id}`;
    if (!original) {
      reply.code(404);
      return { error: 'not found' };
    }

    // Re-validate against current guard config — the original run may predate
    // tighter limits, or the host may have been removed from the allowlist.
    const hostGuard = isHostAllowed(original.baseUrl);
    if (!hostGuard.ok) {
      reply.code(403);
      return { error: hostGuard.reason };
    }
    if (original.config?.execution) {
      const capsGuard = checkExecutionCaps(original.config.execution);
      if (!capsGuard.ok) {
        reply.code(403);
        return { error: capsGuard.reason };
      }
    }
    const concurrentGuard = await checkConcurrentRunCap();
    if (!concurrentGuard.ok) {
      reply.code(429);
      return { error: concurrentGuard.reason };
    }

    const [row] = await sql`
      INSERT INTO runs (service, base_url, profile, vus, duration, config, triggered_by, status)
      VALUES (
        ${original.service},
        ${original.baseUrl},
        ${original.profile},
        ${original.vus},
        ${original.duration},
        ${sql.json(original.config as any)},
        ${original.triggeredBy ?? null},
        'queued'
      )
      RETURNING id, queued_at
    `;
    await runQueue.add('run', { runId: row.id }, { jobId: row.id });
    return { id: row.id, status: 'queued', queuedAt: row.queuedAt };
  });

  app.delete<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const id = req.params.id;
    const [existing] = await sql`SELECT status FROM runs WHERE id = ${id}`;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    // If the run is currently executing, signal the worker that owns the
    // child process to kill it. Pub/sub is fire-and-forget — only the worker
    // holding the ChildProcess for this runId will act on it.
    if (existing.status === 'running') {
      try {
        await redisPub.publish(CANCEL_CHANNEL, id);
      } catch (err) {
        app.log.warn({ err }, `failed to publish cancel for ${id}`);
      }
    }
    // Best-effort: remove from queue if still pending or active.
    try {
      const job = await runQueue.getJob(id);
      if (job) await job.remove();
    } catch (err) {
      app.log.warn({ err }, `failed to remove queue job ${id}`);
    }
    await sql`DELETE FROM runs WHERE id = ${id}`;
    reply.code(204);
    return;
  });
};
