import { sql } from '../db.ts';
import { parseDuration, type Execution, summarizeExecution } from './profiles.ts';

/**
 * Internal-team safety guards. All driven by env vars. Empty/unset = no limit
 * so the platform stays backward-compatible if you don't configure them.
 */

// Comma-separated patterns. Each pattern is either an exact hostname or
// a `*.suffix` wildcard. Examples:
//   TARGET_HOST_ALLOWLIST=api.example.com,*.internal.example.com
function getAllowlistPatterns(): string[] {
  const raw = process.env.TARGET_HOST_ALLOWLIST?.trim() ?? '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function matchesPattern(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return false;
}

export function isHostAllowed(targetUrl: string): { ok: true } | { ok: false; reason: string } {
  const patterns = getAllowlistPatterns();
  if (patterns.length === 0) return { ok: true };
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return { ok: false, reason: `invalid URL: ${targetUrl}` };
  }
  const allowed = patterns.some((p) => matchesPattern(host, p));
  if (!allowed) {
    return {
      ok: false,
      reason: `target host "${host}" is not on the allowlist (${patterns.join(', ')})`,
    };
  }
  return { ok: true };
}

function intEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function checkExecutionCaps(
  exec: Execution,
): { ok: true } | { ok: false; reason: string } {
  const maxVus = intEnv('MAX_VUS');
  const maxSeconds = intEnv('MAX_DURATION_SECONDS');
  const { peakVUs, totalDuration } = summarizeExecution(exec);
  if (maxVus !== null && peakVUs > maxVus) {
    return { ok: false, reason: `peak VUs ${peakVUs} exceeds cap of ${maxVus}` };
  }
  if (maxSeconds !== null) {
    const seconds = parseDuration(totalDuration);
    if (seconds > maxSeconds) {
      return {
        ok: false,
        reason: `total duration ${totalDuration} (${seconds}s) exceeds cap of ${maxSeconds}s`,
      };
    }
  }
  return { ok: true };
}

export async function checkConcurrentRunCap(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const cap = intEnv('MAX_CONCURRENT_RUNS');
  if (cap === null) return { ok: true };
  const [{ count }] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM runs WHERE status IN ('queued', 'running')
  `;
  if (count >= cap) {
    return {
      ok: false,
      reason: `max concurrent runs (${cap}) already in progress — cancel one or wait`,
    };
  }
  return { ok: true };
}
