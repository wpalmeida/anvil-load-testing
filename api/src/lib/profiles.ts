import { z } from 'zod';

export const Stage = z.object({
  duration: z.string().regex(/^\d+(ms|s|m|h)$/),
  target: z.number().int().min(0).max(10000),
});
export type Stage = z.infer<typeof Stage>;

export const Profile = z.enum(['smoke', 'load', 'stress', 'spike', 'soak', 'custom']);
export type Profile = z.infer<typeof Profile>;

export type Execution =
  | { executor: 'constant-vus'; vus: number; duration: string }
  | { executor: 'ramping-vus'; startVUs: number; stages: Stage[] };

const CONSTANT_PROFILES = new Set<Profile>(['smoke', 'load', 'soak']);
const RAMPING_PROFILES = new Set<Profile>(['stress', 'spike', 'custom']);

export type NormalizeInput = {
  profile: Profile;
  vus?: number;
  duration?: string;
  stages?: Stage[];
  startVUs?: number;
};

export function normalizeExecution(input: NormalizeInput): Execution {
  if (input.profile === 'smoke') {
    return { executor: 'constant-vus', vus: 1, duration: '30s' };
  }
  if (CONSTANT_PROFILES.has(input.profile)) {
    if (!input.vus || !input.duration) {
      throw new Error(`profile ${input.profile} requires "vus" and "duration"`);
    }
    return { executor: 'constant-vus', vus: input.vus, duration: input.duration };
  }
  if (RAMPING_PROFILES.has(input.profile)) {
    if (!input.stages || input.stages.length === 0) {
      throw new Error(`profile ${input.profile} requires non-empty "stages"`);
    }
    return {
      executor: 'ramping-vus',
      startVUs: input.startVUs ?? 0,
      stages: input.stages,
    };
  }
  throw new Error(`unknown profile: ${input.profile}`);
}

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

export function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 0;
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)}m`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

export function summarizeExecution(exec: Execution): { peakVUs: number; totalDuration: string } {
  if (exec.executor === 'constant-vus') {
    return { peakVUs: exec.vus, totalDuration: exec.duration };
  }
  const peak = exec.stages.reduce((m, s) => Math.max(m, s.target), exec.startVUs);
  const total = exec.stages.reduce((acc, s) => acc + parseDuration(s.duration), 0);
  return { peakVUs: peak, totalDuration: formatDuration(total) };
}
