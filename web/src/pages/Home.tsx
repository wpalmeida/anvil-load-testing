import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { discover, listRecentSpecs, deleteSpec, type RecentSpec } from '../api';

export function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentSpec[] | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listRecentSpecs()
      .then((r) => setRecent(r.recent))
      .catch(() => setRecent([]));
  }, []);

  async function runDiscover(target: string, source: string | null = null) {
    setLoading(true);
    setError(null);
    if (source) setPickingId(source);
    try {
      const result = await discover(target);
      sessionStorage.setItem('anvil:discover', JSON.stringify(result));
      navigate('/configure');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setPickingId(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runDiscover(url);
  }

  async function onForget(e: React.MouseEvent, spec: RecentSpec) {
    e.stopPropagation();
    if (!confirm(`Forget "${spec.title || spec.baseUrl}" from recent list?`)) return;
    try {
      await deleteSpec(spec.id);
      setRecent((prev) => (prev ? prev.filter((s) => s.baseUrl !== spec.baseUrl) : prev));
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold">Discover an API</h1>
          <p className="mt-1 text-sm text-slate-600">
            Paste an API base URL or a direct OpenAPI/Swagger spec URL. We'll probe common
            spec locations (<code>/openapi.json</code>, <code>/v3/api-docs</code>, etc.).
          </p>
        </div>
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="url"
            required
            placeholder="https://api.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading && !pickingId ? 'Discovering…' : 'Discover'}
          </button>
        </form>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {recent && recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Recent</h2>
          <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
            {recent.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => runDiscover(s.specUrl, s.id)}
                  disabled={loading}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {s.title || s.baseUrl}
                      {s.version && (
                        <span className="ml-2 text-xs text-slate-500">v{s.version}</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      <code>{s.baseUrl}</code> · last fetched{' '}
                      {new Date(s.fetchedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="ml-3 flex items-center gap-3 text-xs text-slate-500">
                    {pickingId === s.id ? <span>discovering…</span> : <span>↻ re-discover</span>}
                    <span
                      role="button"
                      onClick={(e) => onForget(e, s)}
                      className="text-slate-400 hover:text-red-600"
                      title="Forget this URL"
                    >
                      ×
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
