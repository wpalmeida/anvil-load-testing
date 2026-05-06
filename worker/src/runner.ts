import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type RunK6Args = {
  script: string;
  influxUrl: string;
  env: Record<string, string>;
  tags: Record<string, string>;
  onSpawn?: (child: ChildProcess) => void;
};

export type RunK6Result = {
  code: number;
  stdout: string;
  stderr: string;
  summary: unknown | null;
};

export async function runK6(args: RunK6Args): Promise<RunK6Result> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k6-'));
  const scriptPath = path.join(dir, 'script.js');
  const summaryPath = path.join(dir, 'summary.json');
  await fs.writeFile(scriptPath, args.script, 'utf-8');

  const tagArgs = Object.entries(args.tags).flatMap(([k, v]) => ['--tag', `${k}=${v}`]);
  const cliArgs = [
    'run',
    '--out',
    `influxdb=${args.influxUrl}`,
    '--summary-export',
    summaryPath,
    ...tagArgs,
    scriptPath,
  ];

  return new Promise<RunK6Result>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('k6', cliArgs, {
      env: { ...process.env, ...args.env },
    });
    args.onSpawn?.(child);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      let summary: unknown = null;
      try {
        summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
      } catch {
        // summary file may be missing if k6 crashed early
      }
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      resolve({ code: code ?? -1, stdout, stderr, summary });
    });
  });
}
