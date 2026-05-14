import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { discover, listRecentSpecs, deleteSpec, type RecentSpec } from '../api';
import { parseHar } from '../lib/har';

export function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentSpec[] | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [harError, setHarError] = useState<string | null>(null);
  const harInputRef = useRef<HTMLInputElement | null>(null);
  const [browserUrl, setBrowserUrl] = useState('');
  const [browserError, setBrowserError] = useState<string | null>(null);
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

  function onStartBrowserFlow(e: React.FormEvent) {
    e.preventDefault();
    setBrowserError(null);
    let parsed: URL;
    try {
      parsed = new URL(browserUrl);
    } catch {
      setBrowserError('Enter a valid URL (e.g. https://app.example.com).');
      return;
    }
    const stub = {
      specId: `browser-${Date.now()}`,
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      specUrl: '',
      title: parsed.host,
      version: '',
      operations: [],
    };
    sessionStorage.setItem('anvil:discover', JSON.stringify(stub));
    sessionStorage.setItem('anvil:start-as-browser', '1');
    navigate('/configure');
  }

  async function onHarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHarError(null);
    try {
      const text = await file.text();
      const result = parseHar(text);
      sessionStorage.setItem('anvil:discover', JSON.stringify(result));
      navigate('/configure');
    } catch (err) {
      setHarError((err as Error).message);
    } finally {
      if (harInputRef.current) harInputRef.current.value = '';
    }
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

      <section className="space-y-2 rounded border border-dashed border-slate-300 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-700">
          Or run a browser flow (k6 browser)
        </h2>
        <p className="text-xs text-slate-600">
          Skip the OpenAPI dance — drive a real Chromium through a user flow (login,
          click, type) and capture Web Vitals. Enter the base URL of the app and define
          the steps on the next screen.
        </p>
        <form onSubmit={onStartBrowserFlow} className="flex gap-2">
          <input
            type="url"
            required
            placeholder="https://app.example.com"
            value={browserUrl}
            onChange={(e) => setBrowserUrl(e.target.value)}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Start browser flow
          </button>
        </form>
        {browserError && <p className="text-sm text-red-600">{browserError}</p>}
      </section>

      <section className="space-y-2 rounded border border-dashed border-slate-300 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-700">
          Or import endpoints from a HAR file
        </h2>
        <p className="text-xs text-slate-600">
          For apps without an OpenAPI spec (Next.js, Rails, etc.): in Chrome DevTools{' '}
          <strong>Network</strong> tab, do the user flow you want to test, then{' '}
          <strong>right-click → Save all as HAR with content</strong>. Upload it here and
          Anvil will extract unique endpoints, filter out static assets, and drop you
          into Configure.
        </p>
        <input
          ref={harInputRef}
          type="file"
          accept=".har,application/json"
          onChange={onHarFile}
          className="block w-full text-xs file:mr-3 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-slate-700"
        />
        {harError && <p className="text-sm text-red-600">{harError}</p>}
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
