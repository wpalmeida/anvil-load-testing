import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listRuns, deleteRun, rerunRun, getRun, discover } from '../api';

type Run = {
  id: string;
  service: string;
  profile: string;
  status: string;
  vus: number | null;
  duration: string | null;
  triggeredBy: string | null;
  queuedAt: string;
  finishedAt: string | null;
};

export function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const navigate = useNavigate();

  function refresh() {
    listRuns()
      .then((r) => setRuns(r.runs))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onDelete(id: string, service: string) {
    if (!confirm(`Delete run for "${service}"? This cannot be undone.`)) return;
    setBusyId(id);
    try {
      await deleteRun(id);
      setRuns((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onRerun(run: Run) {
    if (!confirmIfActive(run, 'rerun')) return;
    setBusyId(run.id);
    try {
      const result = await rerunRun(run.id);
      navigate(`/runs/${result.id}`);
    } catch (err) {
      alert(`Failed to rerun: ${(err as Error).message}`);
      setBusyId(null);
    }
  }

  async function onEdit(run: Run) {
    if (!confirmIfActive(run, 'edit')) return;
    setBusyId(run.id);
    try {
      await loadRunIntoConfigure(run.id);
      navigate('/configure');
    } catch (err) {
      alert(`Failed to open editor: ${(err as Error).message}`);
      setBusyId(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!runs) return <p className="text-sm text-slate-600">Loading…</p>;
  if (runs.length === 0) return <p className="text-sm text-slate-600">No runs yet.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-slate-500">
        <tr>
          <th className="py-2">Service</th>
          <th>Profile</th>
          <th>Status</th>
          <th>VUs/Duration</th>
          <th>Triggered by</th>
          <th>Queued at</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="border-t border-slate-200">
            <td className="py-2">
              <Link to={`/runs/${r.id}`} className="text-slate-900 underline">
                {r.service}
              </Link>
            </td>
            <td>{r.profile}</td>
            <td>
              <span className={statusClass(r.status)}>{r.status}</span>
            </td>
            <td>
              {r.vus ?? '—'} / {r.duration ?? '—'}
            </td>
            <td>{r.triggeredBy ?? '—'}</td>
            <td className="text-slate-500">{new Date(r.queuedAt).toLocaleString()}</td>
            <td className="text-right">
              <div className="inline-flex items-center gap-3 text-xs">
                <button
                  onClick={() => onRerun(r)}
                  disabled={busyId === r.id}
                  className="text-slate-700 hover:text-slate-900 disabled:opacity-50"
                  title="Run again with the same config"
                >
                  rerun
                </button>
                <button
                  onClick={() => onEdit(r)}
                  disabled={busyId === r.id}
                  className="text-slate-700 hover:text-slate-900 disabled:opacity-50"
                  title="Clone this run's config — edit before submitting as a new run"
                >
                  clone
                </button>
                <button
                  onClick={() => onDelete(r.id, r.service)}
                  disabled={busyId === r.id}
                  className="text-slate-500 hover:text-red-600 disabled:opacity-50"
                  title="Delete run"
                >
                  {busyId === r.id ? '…' : 'delete'}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function loadRunIntoConfigure(runId: string) {
  const run = await getRun(runId);
  const testType: 'http' | 'browser' = run.config?.testType ?? 'http';

  // Browser runs were never driven by an OpenAPI spec — skip discovery and
  // write a stub so Configure has the shape it expects in sessionStorage.
  let spec;
  if (testType === 'browser') {
    spec = {
      specId: `clone-${runId}`,
      baseUrl: run.baseUrl,
      specUrl: '',
      title: run.service,
      version: '',
      operations: [],
    };
  } else {
    try {
      spec = await discover(run.baseUrl);
    } catch (err) {
      throw new Error(
        `Could not re-discover spec at ${run.baseUrl}: ${(err as Error).message}. ` +
          `The original run is unchanged; you can rerun it as-is from the runs list.`,
      );
    }
  }

  const savedOps: Array<{ method: string; path: string }> = run.config?.operations ?? [];
  const specKeys = new Set(spec.operations.map((o) => `${o.method} ${o.path}`));
  const drifted =
    testType === 'http'
      ? savedOps
          .filter((o) => !specKeys.has(`${o.method} ${o.path}`))
          .map(({ method, path }) => ({ method, path }))
      : [];

  sessionStorage.setItem('anvil:discover', JSON.stringify(spec));
  sessionStorage.setItem(
    'anvil:rerun-config',
    JSON.stringify({
      runId,
      service: run.service,
      triggeredBy: run.triggeredBy,
      profile: run.profile,
      authHeaders: run.config?.authHeaders ?? {},
      execution: run.config?.execution ?? null,
      operations: run.config?.operations ?? [],
      thresholds: run.config?.thresholds ?? [],
      setup: run.config?.setup ?? [],
      teardown: run.config?.teardown ?? [],
      datasets: (run.config?.datasets ?? []).map((d: any) => ({
        name: d.name,
        format: 'json' as const,
        content: JSON.stringify(d.records ?? [], null, 2),
      })),
      testType,
      browserSteps: run.config?.browserSteps ?? [],
      browserIterations: run.config?.browserIterations ?? 10,
      browserMaxDuration: run.config?.browserMaxDuration ?? '5m',
    }),
  );
  if (drifted.length > 0) {
    sessionStorage.setItem('anvil:rerun-drift', JSON.stringify(drifted));
  } else {
    sessionStorage.removeItem('anvil:rerun-drift');
  }
}

export function confirmIfActive(
  run: { status: string; service: string },
  verb: 'rerun' | 'edit',
): boolean {
  if (run.status !== 'running' && run.status !== 'queued') return true;
  const action =
    verb === 'rerun'
      ? `Start a new run anyway? The original will keep running — delete it separately if you want to stop it.`
      : `Open the editor anyway? The original will keep running, and submitting will create a new run.`;
  return confirm(`The original run for "${run.service}" is ${run.status}. ${action}`);
}

function statusClass(s: string) {
  switch (s) {
    case 'completed':
      return 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-800';
    case 'failed':
      return 'rounded bg-red-100 px-2 py-0.5 text-xs text-red-800';
    case 'running':
      return 'rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800';
    default:
      return 'rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700';
  }
}
