import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getRun, deleteRun, rerunRun } from '../api';
import { loadRunIntoConfigure, confirmIfActive } from './Runs';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    if (!id || !run) return;
    if (!confirm(`Delete run for "${run.service}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteRun(id);
      navigate('/runs');
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
      setDeleting(false);
    }
  }

  async function onRerun() {
    if (!id || !run) return;
    if (!confirmIfActive(run, 'rerun')) return;
    try {
      const result = await rerunRun(id);
      navigate(`/runs/${result.id}`);
    } catch (err) {
      alert(`Failed to rerun: ${(err as Error).message}`);
    }
  }

  async function onEdit() {
    if (!id || !run) return;
    if (!confirmIfActive(run, 'edit')) return;
    try {
      await loadRunIntoConfigure(id);
      navigate('/configure');
    } catch (err) {
      alert(`Failed to open editor: ${(err as Error).message}`);
    }
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function loop() {
      try {
        const r = await getRun(id!);
        if (cancelled) return;
        setRun(r);
        if (r.status !== 'completed' && r.status !== 'failed') {
          setTimeout(loop, 2000);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    }
    loop();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!run) return <p className="text-sm text-slate-600">Loading…</p>;

  const metrics = run.summary?.metrics ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{run.service}</h1>
        <p className="text-sm text-slate-600">
          {run.profile} · {run.vus} VUs · {run.duration} · status:{' '}
          <strong>{run.status}</strong>
        </p>
        <div className="mt-2 flex gap-2">
          {run.grafanaUrl && (
            <a
              href={run.grafanaUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
            >
              Open in Grafana →
            </a>
          )}
          <button
            onClick={onRerun}
            className="inline-block rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Rerun
          </button>
          <button
            onClick={onEdit}
            className="inline-block rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            title="Clone this run's config — edit before submitting as a new run"
          >
            Clone & run
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="inline-block rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete run'}
          </button>
        </div>
      </div>

      {run.error && (
        <pre className="overflow-auto rounded bg-red-50 p-3 text-xs text-red-900">{run.error}</pre>
      )}

      {run.config?.thresholds && run.config.thresholds.length > 0 && (
        <ThresholdResults thresholds={run.config.thresholds} metrics={metrics} />
      )}

      {metrics && (
        <section className="space-y-2">
          <h2 className="font-semibold">k6 summary</h2>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <Stat label="Iterations" value={metric(metrics, 'iterations', 'count')} />
            <Stat label="Requests" value={metric(metrics, 'http_reqs', 'count')} />
            <Stat
              label="Failure rate"
              value={fmtPct(metric(metrics, 'http_req_failed', 'value'))}
            />
            <Stat label="avg (ms)" value={fmt(metric(metrics, 'http_req_duration', 'avg'))} />
            <Stat
              label="p95 (ms)"
              value={fmt(metric(metrics, 'http_req_duration', 'p(95)'))}
            />
            <Stat
              label="p99 (ms)"
              value={fmt(metric(metrics, 'http_req_duration', 'p(99)'))}
            />
            <Stat label="min (ms)" value={fmt(metric(metrics, 'http_req_duration', 'min'))} />
            <Stat label="max (ms)" value={fmt(metric(metrics, 'http_req_duration', 'max'))} />
            <Stat
              label="Data received"
              value={fmtBytes(metric(metrics, 'data_received', 'count'))}
            />
          </div>
        </section>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-600">Raw run data</summary>
        <pre className="mt-2 overflow-auto rounded bg-slate-100 p-3">{JSON.stringify(run, null, 2)}</pre>
      </details>
    </div>
  );
}

function ThresholdResults({
  thresholds,
  metrics,
}: {
  thresholds: Array<{ metric: string; expression: string; abortOnFail?: boolean }>;
  metrics: any;
}) {
  // k6 stores result under metrics.<name>.thresholds[<expression>] = { ok: bool }.
  // While the run is still in progress, metrics may be null — show "pending".
  function status(metric: string, expression: string): 'pass' | 'fail' | 'pending' {
    const m = metrics?.[metric];
    const t = m?.thresholds?.[expression];
    if (!t) return 'pending';
    return t.ok ? 'pass' : 'fail';
  }
  const anyFail = thresholds.some((t) => status(t.metric, t.expression) === 'fail');
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">
        Thresholds{' '}
        {anyFail ? (
          <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">
            FAILED
          </span>
        ) : (
          <span className="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
            PASSED
          </span>
        )}
      </h2>
      <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white text-sm">
        {thresholds.map((t, i) => {
          const s = status(t.metric, t.expression);
          return (
            <li key={i} className="flex items-center justify-between px-3 py-2">
              <code className="font-mono text-xs">
                {t.metric}: {t.expression}
              </code>
              <span className={badgeClass(s)}>{s}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function badgeClass(s: 'pass' | 'fail' | 'pending') {
  switch (s) {
    case 'pass':
      return 'rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800';
    case 'fail':
      return 'rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800';
    default:
      return 'rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700';
  }
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{value ?? '—'}</div>
    </div>
  );
}

function fmt(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  return n.toFixed(1);
}

function fmtPct(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  return (n * 100).toFixed(2) + '%';
}

function fmtBytes(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// k6's --summary-export nests numeric fields under `values` in some versions
// and exposes them at the top level in others. Try both.
function metric(metrics: any, name: string, field: string): number | undefined {
  const m = metrics?.[name];
  if (!m) return undefined;
  if (m[field] !== undefined && m[field] !== null) return m[field];
  if (m.values?.[field] !== undefined && m.values?.[field] !== null) return m.values[field];
  return undefined;
}
