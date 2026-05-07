import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createRun,
  type DiscoverResult,
  type Operation,
  type Threshold,
  type Step,
  type DatasetInput,
} from '../api';
import { PROFILE_DEFAULTS, type Profile, type Stage } from '../profiles';

const THRESHOLD_PRESETS = [
  {
    metric: 'http_req_duration',
    label: 'Response time',
    stats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    unit: 'ms',
    valueIsRate: false,
  },
  {
    metric: 'http_req_failed',
    label: 'Failure rate',
    stats: ['rate'],
    unit: '%',
    valueIsRate: true,
  },
  {
    metric: 'iteration_duration',
    label: 'Iteration duration',
    stats: ['avg', 'p(95)', 'max'],
    unit: 'ms',
    valueIsRate: false,
  },
  {
    metric: 'http_reqs',
    label: 'Requests',
    stats: ['count', 'rate'],
    unit: '',
    valueIsRate: false,
  },
  {
    metric: 'checks',
    label: 'Check pass rate',
    stats: ['rate'],
    unit: '%',
    valueIsRate: true,
  },
] as const;

const THRESHOLD_OPS = ['<', '<=', '>', '>=', '==', '!='] as const;

type ThresholdRow = {
  metric: string;
  stat: string;
  op: string;
  value: string;
};

function presetFor(metric: string) {
  return THRESHOLD_PRESETS.find((p) => p.metric === metric) ?? THRESHOLD_PRESETS[0];
}

function rowToThreshold(row: ThresholdRow): Threshold | null {
  if (!row.metric || !row.stat || !row.op || row.value === '') return null;
  const v = Number(row.value);
  if (Number.isNaN(v)) return null;
  const preset = presetFor(row.metric);
  const numeric = preset.valueIsRate ? v / 100 : v;
  return { metric: row.metric, expression: `${row.stat}${row.op}${numeric}` };
}

function thresholdToRow(t: Threshold): ThresholdRow | null {
  // Parse an expression like "p(95)<500" or "rate<0.01" back into structured fields.
  const m = t.expression.match(/^([a-zA-Z()0-9.]+)(<=|>=|==|!=|<|>)(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, stat, op, valueStr] = m;
  const preset = presetFor(t.metric);
  const v = Number(valueStr);
  const display = preset.valueIsRate ? v * 100 : v;
  return { metric: t.metric, stat, op, value: String(display) };
}

type SelectedConfig = {
  selected: boolean;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  body: string;
  // When true, ParamGroup hides empty entries until the user expands. Used
  // for cloned runs so the user sees only what was previously filled, with
  // an explicit toggle to reveal the rest of the spec's params.
  hideEmptyQuery: boolean;
};

function defaultFor(p: { example: unknown; schema: any }): string {
  if (p.example !== undefined && p.example !== null) return String(p.example);
  if (p.schema?.example !== undefined && p.schema?.example !== null) return String(p.schema.example);
  if (p.schema?.default !== undefined && p.schema?.default !== null) return String(p.schema.default);
  return '';
}

function defaultBody(op: Operation): string {
  const ex = op.requestBody?.example ?? op.requestBody?.schema?.example;
  if (ex === undefined || ex === null) return '';
  return typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
}

export function Configure() {
  const navigate = useNavigate();
  const [data, setData] = useState<DiscoverResult | null>(null);
  const [configs, setConfigs] = useState<Record<string, SelectedConfig>>({});
  const [service, setService] = useState('');
  const [triggeredBy, setTriggeredBy] = useState('');
  const [authRows, setAuthRows] = useState<Array<{ name: string; value: string }>>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [thresholdRows, setThresholdRows] = useState<ThresholdRow[]>([]);
  const [setupSteps, setSetupSteps] = useState<Step[]>([]);
  const [teardownSteps, setTeardownSteps] = useState<Step[]>([]);
  const [datasets, setDatasets] = useState<DatasetInput[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [profile, setProfile] = useState<Profile>('smoke');
  const [vus, setVus] = useState(PROFILE_DEFAULTS.smoke.vus ?? 1);
  const [duration, setDuration] = useState(PROFILE_DEFAULTS.smoke.duration ?? '30s');
  const [stages, setStages] = useState<Stage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydratedFromRunId, setHydratedFromRunId] = useState<string | null>(null);
  const [driftedOps, setDriftedOps] = useState<Array<{ method: string; path: string }>>([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    // Strict Mode runs effects twice in dev. We consume sessionStorage entries
    // here, so guard with a ref to avoid the second pass clobbering hydration
    // with empty data.
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    const raw = sessionStorage.getItem('anvil:discover');
    if (!raw) {
      navigate('/');
      return;
    }
    const parsed: DiscoverResult = JSON.parse(raw);
    setData(parsed);

    const initial: Record<string, SelectedConfig> = {};
    for (const op of parsed.operations) {
      const key = `${op.method} ${op.path}`;
      initial[key] = {
        selected: false,
        pathParams: Object.fromEntries(
          op.parameters.filter((p) => p.in === 'path').map((p) => [p.name, defaultFor(p)]),
        ),
        queryParams: Object.fromEntries(
          op.parameters.filter((p) => p.in === 'query').map((p) => [p.name, defaultFor(p)]),
        ),
        body: defaultBody(op),
        hideEmptyQuery: false,
      };
    }

    const driftRaw = sessionStorage.getItem('anvil:rerun-drift');
    if (driftRaw) {
      sessionStorage.removeItem('anvil:rerun-drift');
      try {
        setDriftedOps(JSON.parse(driftRaw));
      } catch {
        // ignore malformed drift payload
      }
    }

    const rerunRaw = sessionStorage.getItem('anvil:rerun-config');
    if (rerunRaw) {
      sessionStorage.removeItem('anvil:rerun-config');
      try {
        const rerun = JSON.parse(rerunRaw) as RerunConfig;
        setHydratedFromRunId(rerun.runId);
        setService(rerun.service ?? new URL(parsed.baseUrl).hostname);
        setTriggeredBy(rerun.triggeredBy ?? '');
        if (rerun.authHeaders) {
          setAuthRows(
            Object.entries(rerun.authHeaders).map(([name, value]) => ({
              name,
              value: String(value),
            })),
          );
        }
        if (rerun.thresholds && rerun.thresholds.length > 0) {
          setThresholdRows(
            rerun.thresholds
              .map((t) => thresholdToRow(t))
              .filter((r): r is ThresholdRow => r !== null),
          );
        }
        if (rerun.setup && rerun.setup.length > 0) setSetupSteps(rerun.setup);
        if (rerun.teardown && rerun.teardown.length > 0) setTeardownSteps(rerun.teardown);
        if (rerun.datasets && rerun.datasets.length > 0) setDatasets(rerun.datasets);
        // Open the advanced panel automatically if any of its sections
        // were used in the original run, so the user sees the carried-over
        // values instead of an empty collapsed group.
        if (
          (rerun.thresholds?.length ?? 0) > 0 ||
          (rerun.setup?.length ?? 0) > 0 ||
          (rerun.teardown?.length ?? 0) > 0 ||
          (rerun.datasets?.length ?? 0) > 0
        ) {
          setAdvancedOpen(true);
        }
        // Hydrate profile + execution from the original run. Resetting to
        // profile defaults only happens when the user manually changes the
        // dropdown (handleProfileChange below), so these saved values stick.
        setProfile(rerun.profile);
        if (rerun.execution?.executor === 'constant-vus') {
          setVus(rerun.execution.vus);
          setDuration(rerun.execution.duration);
        } else if (rerun.execution?.executor === 'ramping-vus') {
          setStages(rerun.execution.stages ?? []);
        }
        // Pre-select operations matched by method + path. Merge saved
        // values onto the spec-derived defaults so unfilled params remain
        // visible (toggle below) — otherwise cloning would lose them.
        for (const savedOp of rerun.operations ?? []) {
          const key = `${savedOp.method} ${savedOp.path}`;
          if (!initial[key]) continue;
          const baseQuery = initial[key].queryParams;
          const savedQuery = stringifyValues(savedOp.queryParams ?? {});
          // Reset spec defaults to empty before overlaying saved values so
          // params the user explicitly cleared in the original run stay empty.
          const blankedQuery: Record<string, string> = {};
          for (const k of Object.keys(baseQuery)) blankedQuery[k] = '';
          const mergedQuery = { ...blankedQuery, ...savedQuery };
          const hasEmpty = Object.values(mergedQuery).some((v) => v === '');
          initial[key] = {
            selected: true,
            pathParams: { ...initial[key].pathParams, ...stringifyValues(savedOp.pathParams ?? {}) },
            queryParams: mergedQuery,
            body: serializeBody(savedOp.body),
            // Hide empties by default when there are some — user can expand.
            hideEmptyQuery: hasEmpty,
          };
        }
      } catch (err) {
        console.warn('failed to hydrate from rerun config:', err);
        setService(new URL(parsed.baseUrl).hostname);
      }
    } else {
      setService(new URL(parsed.baseUrl).hostname);
    }

    setConfigs(initial);
  }, [navigate]);

  // Apply profile defaults only when the *user* changes the dropdown.
  // Driven by an explicit handler (not a useEffect on `profile`) so that
  // hydration from a cloned run doesn't get clobbered by an initial-mount
  // reset before the saved values have committed.
  function handleProfileChange(newProfile: Profile) {
    setProfile(newProfile);
    const def = PROFILE_DEFAULTS[newProfile];
    if (def.vus !== undefined) setVus(def.vus);
    if (def.duration !== undefined) setDuration(def.duration);
    setStages(def.stages ? [...def.stages] : []);
  }

  const profileDef = PROFILE_DEFAULTS[profile];
  const selectedCount = useMemo(
    () => Object.values(configs).filter((c) => c.selected).length,
    [configs],
  );

  const [search, setSearch] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  const filteredOperations = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.operations.filter((op) => {
      const cfg = configs[`${op.method} ${op.path}`];
      if (showSelectedOnly && !cfg?.selected) return false;
      if (!q) return true;
      return (
        op.path.toLowerCase().includes(q) ||
        op.method.toLowerCase().includes(q) ||
        op.summary?.toLowerCase().includes(q) ||
        op.operationId?.toLowerCase().includes(q)
      );
    });
  }, [data, configs, search, showSelectedOnly]);

  function update(opKey: string, fn: (c: SelectedConfig) => SelectedConfig) {
    setConfigs((prev) => ({ ...prev, [opKey]: fn(prev[opKey]) }));
  }

  function setAllVisible(selected: boolean) {
    setConfigs((prev) => {
      const next = { ...prev };
      for (const op of filteredOperations) {
        const key = `${op.method} ${op.path}`;
        if (next[key]) next[key] = { ...next[key], selected };
      }
      return next;
    });
  }

  async function onSubmit() {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    try {
      const operations = data.operations
        .filter((op) => configs[`${op.method} ${op.path}`]?.selected)
        .map((op) => {
          const cfg = configs[`${op.method} ${op.path}`];
          let body: unknown = undefined;
          if (cfg.body.trim()) {
            try {
              body = JSON.parse(cfg.body);
            } catch {
              body = cfg.body;
            }
          }
          return {
            method: op.method,
            path: op.path,
            pathParams: stripEmpty(cfg.pathParams),
            queryParams: stripEmpty(cfg.queryParams),
            body,
          };
        });
      const payload =
        profileDef.kind === 'constant'
          ? { vus, duration }
          : { stages, startVUs: profileDef.startVUs ?? 0 };
      const authHeaders: Record<string, string> = {};
      for (const row of authRows) {
        const name = row.name.trim();
        if (name && row.value) authHeaders[name] = row.value;
      }
      const thresholds = thresholdRows
        .map(rowToThreshold)
        .filter((t): t is Threshold => t !== null);
      const result = await createRun({
        service,
        baseUrl: data.baseUrl,
        triggeredBy: triggeredBy || undefined,
        authHeaders: Object.keys(authHeaders).length > 0 ? authHeaders : undefined,
        profile,
        ...payload,
        operations,
        thresholds: thresholds.length > 0 ? thresholds : undefined,
        setup: setupSteps.length > 0 ? setupSteps : undefined,
        teardown: teardownSteps.length > 0 ? teardownSteps : undefined,
        datasets: datasets.length > 0 ? datasets : undefined,
      });
      navigate(`/runs/${result.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) return null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{data.title}</h1>
        <p className="text-sm text-slate-600">
          Base URL: <code className="text-slate-800">{data.baseUrl}</code>
          {data.version && <> · v{data.version}</>}
        </p>
        {hydratedFromRunId && (
          <p className="mt-2 inline-block rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 ring-1 ring-amber-200">
            Cloned from run <code>{hydratedFromRunId.slice(0, 8)}</code> — submitting will create a
            new run; the original is unchanged.
          </p>
        )}
        {driftedOps.length > 0 && (
          <div className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
            <p className="font-semibold">
              Spec drift: {driftedOps.length} operation
              {driftedOps.length === 1 ? '' : 's'} from the original run{' '}
              {driftedOps.length === 1 ? 'is' : 'are'} no longer in the discovered spec and{' '}
              {driftedOps.length === 1 ? 'has' : 'have'} been dropped.
            </p>
            <ul className="mt-1 list-disc pl-5">
              {driftedOps.map((o, i) => (
                <li key={i}>
                  <code className="font-mono">
                    {o.method.toUpperCase()} {o.path}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Run settings</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="block">
            <span className="block text-slate-700">Service name</span>
            <input
              value={service}
              onChange={(e) => setService(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="block">
            <span className="block text-slate-700">Triggered by</span>
            <input
              value={triggeredBy}
              onChange={(e) => setTriggeredBy(e.target.value)}
              placeholder="your name"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
        </div>

        <div className="border-t border-slate-100 pt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-slate-700">Auth headers (optional)</p>
            <button
              type="button"
              onClick={() => setAuthRows((r) => [...r, { name: '', value: '' }])}
              className="text-xs text-slate-700 underline hover:text-slate-900"
            >
              + add header
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Sent on every request. Examples:{' '}
            <code>Authorization: Bearer …</code>, <code>X-Api-Key: …</code>,{' '}
            <code>X-Internal-Token: …</code>
          </p>
          <div className="mt-2 space-y-2">
            {authRows.length === 0 && (
              <p className="text-xs text-slate-500">No auth headers — requests sent unauthenticated.</p>
            )}
            {authRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={row.name}
                  onChange={(e) =>
                    setAuthRows((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                    )
                  }
                  placeholder="Header name"
                  className="w-48 rounded border border-slate-300 px-2 py-1 text-xs font-mono"
                />
                <input
                  type={revealed[i] ? 'text' : 'password'}
                  value={row.value}
                  onChange={(e) =>
                    setAuthRows((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    )
                  }
                  placeholder="Header value"
                  className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((s) => ({ ...s, [i]: !s[i] }))}
                  className="text-xs text-slate-500 hover:text-slate-900"
                  title={revealed[i] ? 'Hide value' : 'Show value'}
                >
                  {revealed[i] ? 'hide' : 'show'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthRows((rows) => rows.filter((_, j) => j !== i));
                    setRevealed((s) => {
                      const { [i]: _, ...rest } = s;
                      return rest;
                    });
                  }}
                  className="text-xs text-slate-500 hover:text-red-600"
                  title="Remove header"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-100 pt-3">
          <label className="block text-sm">
            <span className="block text-slate-700">Profile</span>
            <select
              value={profile}
              onChange={(e) => handleProfileChange(e.target.value as Profile)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            >
              <option value="smoke">smoke</option>
              <option value="load">load</option>
              <option value="stress">stress</option>
              <option value="spike">spike</option>
              <option value="soak">soak</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-500">{profileDef.description}</p>
        </div>

        {profileDef.kind === 'constant' && (
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
            <label className="block">
              <span className="block text-slate-700">VUs</span>
              <input
                type="number"
                min={1}
                max={10000}
                disabled={!profileDef.editable.vus}
                value={vus}
                onChange={(e) => setVus(Number(e.target.value))}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
              />
            </label>
            <label className="block">
              <span className="block text-slate-700">Duration (e.g. 30s, 5m, 1h)</span>
              <input
                disabled={!profileDef.editable.duration}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
              />
            </label>
          </div>
        )}

        {profileDef.kind === 'ramping' && (
          <StageEditor stages={stages} onChange={setStages} />
        )}

        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="border-t border-slate-100 pt-3"
        >
          <summary className="cursor-pointer select-none text-sm font-medium text-slate-700 hover:text-slate-900">
            Advanced settings
            <span className="ml-2 text-xs font-normal text-slate-500">
              ({advancedSummary({
                thresholds: thresholdRows.length,
                setup: setupSteps.length,
                teardown: teardownSteps.length,
                datasets: datasets.length,
              })})
            </span>
          </summary>
          <div className="mt-3 space-y-1">
            <ThresholdEditor rows={thresholdRows} onChange={setThresholdRows} />

            <StepsEditor
              label="Setup steps"
              help="Run once before the load phase. Use to log in, seed data, etc. Bind values from responses (e.g. token from JSON) so operations can reference them as {{name}} in headers and body."
              steps={setupSteps}
              onChange={setSetupSteps}
            />

            <StepsEditor
              label="Teardown steps"
              help="Run once after the load phase. Use to clean up data, log out, etc. Setup-extracted variables are available here too."
              steps={teardownSteps}
              onChange={setTeardownSteps}
            />

            <DatasetsEditor datasets={datasets} onChange={setDatasets} />
          </div>
        </details>
      </section>

      <section className="pb-20">
        <div className="sticky top-0 z-10 -mx-6 border-b border-slate-200 bg-slate-50/95 px-6 py-3 backdrop-blur-sm">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">
                Operations{' '}
                <span className="text-sm font-normal text-slate-500">
                  ({selectedCount} selected · {filteredOperations.length} of{' '}
                  {data.operations.length} shown)
                </span>
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setAllVisible(true)}
                  disabled={filteredOperations.length === 0}
                  className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-50"
                >
                  select all visible
                </button>
                <button
                  type="button"
                  onClick={() => setAllVisible(false)}
                  disabled={filteredOperations.length === 0}
                  className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-50"
                >
                  clear visible
                </button>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={showSelectedOnly}
                    onChange={(e) => setShowSelectedOnly(e.target.checked)}
                  />
                  show selected only
                </label>
              </div>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by method, path, summary, or operationId…"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {filteredOperations.length === 0 && (
            <p className="rounded border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">
              {showSelectedOnly && selectedCount === 0
                ? 'No operations selected yet.'
                : 'No operations match the filter.'}
            </p>
          )}
          {filteredOperations.map((op) => {
            const key = `${op.method} ${op.path}`;
            const cfg = configs[key];
            if (!cfg) return null;
            return (
              <div
                key={key}
                className={`rounded border p-3 text-sm transition-colors ${
                  cfg.selected
                    ? 'border-blue-300 bg-blue-50/60'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={cfg.selected}
                    onChange={(e) =>
                      update(key, (c) => ({ ...c, selected: e.target.checked }))
                    }
                  />
                  <MethodBadge method={op.method} />
                  <span className="font-mono">{op.path}</span>
                  <span className="text-slate-500">{op.summary}</span>
                </label>
                {cfg.selected && (
                  <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                    {Object.keys(cfg.pathParams).length > 0 && (
                      <ParamGroup
                        label="Path params"
                        values={cfg.pathParams}
                        onChange={(next) => update(key, (c) => ({ ...c, pathParams: next }))}
                      />
                    )}
                    {Object.keys(cfg.queryParams).length > 0 && (
                      <ParamGroup
                        label="Query params"
                        values={cfg.queryParams}
                        hideEmpty={cfg.hideEmptyQuery}
                        onToggleHideEmpty={() =>
                          update(key, (c) => ({ ...c, hideEmptyQuery: !c.hideEmptyQuery }))
                        }
                        onChange={(next) => update(key, (c) => ({ ...c, queryParams: next }))}
                      />
                    )}
                    {op.requestBody && (
                      <label className="block">
                        <span className="block text-slate-700">
                          Request body ({op.requestBody.contentType})
                        </span>
                        <textarea
                          rows={5}
                          value={cfg.body}
                          onChange={(e) =>
                            update(key, (c) => ({ ...c, body: e.target.value }))
                          }
                          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                        />
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
          <div className="text-sm text-slate-700">
            <strong>{selectedCount}</strong> operation{selectedCount === 1 ? '' : 's'} selected
            {error && <span className="ml-3 text-red-600">{error}</span>}
          </div>
          <button
            onClick={onSubmit}
            disabled={submitting || selectedCount === 0}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Queueing…' : `Run on ${selectedCount} operation${selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DatasetsEditor({
  datasets,
  onChange,
}: {
  datasets: DatasetInput[];
  onChange: (next: DatasetInput[]) => void;
}) {
  function update(idx: number, patch: Partial<DatasetInput>) {
    onChange(datasets.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }
  function remove(idx: number) {
    onChange(datasets.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...datasets, { name: '', format: 'json', content: '' }]);
  }
  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-slate-700">Datasets (optional)</p>
        <button
          type="button"
          onClick={add}
          className="text-xs text-slate-700 underline hover:text-slate-900"
        >
          + add dataset
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Each iteration picks a random row. Reference fields as{' '}
        <code>{'{{name.field}}'}</code> in operation headers, body, or auth headers.
        JSON must be an array of objects; CSV's first row is the header.
      </p>
      <div className="mt-2 space-y-3">
        {datasets.length === 0 && (
          <p className="text-xs text-slate-500">
            No datasets — every iteration sends the same body.
          </p>
        )}
        {datasets.map((ds, i) => (
          <div key={i} className="rounded border border-slate-200 bg-white p-3 text-xs">
            <div className="flex items-center gap-2">
              <input
                value={ds.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="users"
                className="w-48 rounded border border-slate-300 px-2 py-1 font-mono"
              />
              <select
                value={ds.format}
                onChange={(e) => update(i, { format: e.target.value as 'json' | 'csv' })}
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
              <span className="text-slate-500">
                {ds.format === 'csv'
                  ? 'first row = headers'
                  : 'array of objects'}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="ml-auto text-slate-500 hover:text-red-600"
                title="Remove dataset"
              >
                ×
              </button>
            </div>
            <textarea
              rows={6}
              value={ds.content}
              onChange={(e) => update(i, { content: e.target.value })}
              placeholder={
                ds.format === 'csv'
                  ? 'email,name\nalice@example.com,Alice\nbob@example.com,Bob'
                  : '[\n  {"email":"alice@example.com","name":"Alice"},\n  {"email":"bob@example.com","name":"Bob"}\n]'
              }
              className="mt-2 w-full rounded border border-slate-300 px-2 py-1 font-mono"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepsEditor({
  label,
  help,
  steps,
  onChange,
}: {
  label: string;
  help: string;
  steps: Step[];
  onChange: (next: Step[]) => void;
}) {
  function update(idx: number, patch: Partial<Step>) {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function remove(idx: number) {
    onChange(steps.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...steps,
      { name: '', method: 'post', url: '', headers: {}, body: '', extract: [] },
    ]);
  }

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-slate-700">{label} (optional)</p>
        <button
          type="button"
          onClick={add}
          className="text-xs text-slate-700 underline hover:text-slate-900"
        >
          + add step
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{help}</p>
      <div className="mt-2 space-y-3">
        {steps.length === 0 && (
          <p className="text-xs text-slate-500">No steps configured.</p>
        )}
        {steps.map((step, i) => (
          <div key={i} className="rounded border border-slate-200 bg-white p-3 text-xs">
            <div className="flex items-center gap-2">
              <input
                value={step.name ?? ''}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="step name (optional)"
                className="flex-1 rounded border border-slate-300 px-2 py-1"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-slate-500 hover:text-red-600"
                title="Remove step"
              >
                ×
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <select
                value={step.method}
                onChange={(e) => update(i, { method: e.target.value as Step['method'] })}
                className="rounded border border-slate-300 px-2 py-1 font-mono uppercase"
              >
                {(['get', 'post', 'put', 'patch', 'delete'] as const).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                value={step.url}
                onChange={(e) => update(i, { url: e.target.value })}
                placeholder="/auth/login or https://other.host/path"
                className="flex-1 rounded border border-slate-300 px-2 py-1 font-mono"
              />
            </div>
            <KvEditor
              label="Headers"
              values={step.headers ?? {}}
              onChange={(next) => update(i, { headers: next })}
            />
            <label className="mt-2 block">
              <span className="block text-slate-600">Body (raw — JSON or other)</span>
              <textarea
                rows={3}
                value={step.body ?? ''}
                onChange={(e) => update(i, { body: e.target.value })}
                placeholder='{"username":"…","password":"…"}'
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono"
              />
            </label>
            <ExtractEditor
              extract={step.extract ?? []}
              onChange={(next) => update(i, { extract: next })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function KvEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(values);
  function update(idx: number, patch: { key?: string; value?: string }) {
    const next = entries.map(([k, v], i) => {
      if (i !== idx) return [k, v] as [string, string];
      return [patch.key ?? k, patch.value ?? v] as [string, string];
    });
    onChange(Object.fromEntries(next));
  }
  function remove(idx: number) {
    onChange(Object.fromEntries(entries.filter((_, i) => i !== idx)));
  }
  function add() {
    onChange({ ...values, '': '' });
  }
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between">
        <span className="text-slate-600">{label}</span>
        <button
          type="button"
          onClick={add}
          className="text-slate-700 underline hover:text-slate-900"
        >
          + add
        </button>
      </div>
      {entries.length === 0 && <p className="text-slate-400">none</p>}
      {entries.map(([k, v], i) => (
        <div key={i} className="mt-1 flex items-center gap-2">
          <input
            value={k}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="header"
            className="w-40 rounded border border-slate-300 px-2 py-1 font-mono"
          />
          <input
            value={v}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            className="flex-1 rounded border border-slate-300 px-2 py-1 font-mono"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-slate-500 hover:text-red-600"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ExtractEditor({
  extract,
  onChange,
}: {
  extract: NonNullable<Step['extract']>;
  onChange: (next: NonNullable<Step['extract']>) => void;
}) {
  function update(idx: number, patch: Partial<NonNullable<Step['extract']>[number]>) {
    onChange(extract.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }
  function remove(idx: number) {
    onChange(extract.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...extract, { name: '', from: 'json', path: '' }]);
  }
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between">
        <span className="text-slate-600">
          Extract bindings — referenced as <code>{'{{name}}'}</code>
        </span>
        <button
          type="button"
          onClick={add}
          className="text-slate-700 underline hover:text-slate-900"
        >
          + add
        </button>
      </div>
      {extract.length === 0 && <p className="text-slate-400">none</p>}
      {extract.map((b, i) => (
        <div key={i} className="mt-1 flex items-center gap-2">
          <input
            value={b.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="varName"
            className="w-32 rounded border border-slate-300 px-2 py-1 font-mono"
          />
          <span className="text-slate-500">from</span>
          <select
            value={b.from}
            onChange={(e) =>
              update(i, { from: e.target.value as 'json' | 'header' | 'status' })
            }
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="json">JSON</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
          </select>
          {b.from !== 'status' && (
            <input
              value={b.path ?? ''}
              onChange={(e) => update(i, { path: e.target.value })}
              placeholder={b.from === 'json' ? 'data.access_token' : 'X-Token'}
              className="flex-1 rounded border border-slate-300 px-2 py-1 font-mono"
            />
          )}
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-slate-500 hover:text-red-600"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ThresholdEditor({
  rows,
  onChange,
}: {
  rows: ThresholdRow[];
  onChange: (next: ThresholdRow[]) => void;
}) {
  function update(idx: number, patch: Partial<ThresholdRow>) {
    onChange(
      rows.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch };
        // If metric changed, reset stat to a valid one for the new metric.
        if (patch.metric && patch.metric !== r.metric) {
          const preset = presetFor(patch.metric);
          if (!(preset.stats as readonly string[]).includes(next.stat)) {
            next.stat = preset.stats[0];
          }
        }
        return next;
      }),
    );
  }
  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...rows,
      { metric: 'http_req_duration', stat: 'p(95)', op: '<', value: '500' },
    ]);
  }

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-slate-700">Thresholds (optional)</p>
        <button
          type="button"
          onClick={add}
          className="text-xs text-slate-700 underline hover:text-slate-900"
        >
          + add threshold
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Pass/fail criteria k6 enforces. If any breaches, the run is marked{' '}
        <strong>failed</strong>.
      </p>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-slate-500">
            No thresholds — the run will only fail on script errors.
          </p>
        )}
        {rows.map((row, i) => {
          const preset = presetFor(row.metric);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={row.metric}
                onChange={(e) => update(i, { metric: e.target.value })}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {THRESHOLD_PRESETS.map((p) => (
                  <option key={p.metric} value={p.metric}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select
                value={row.stat}
                onChange={(e) => update(i, { stat: e.target.value })}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {preset.stats.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={row.op}
                onChange={(e) => update(i, { op: e.target.value })}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {THRESHOLD_OPS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
                className="w-24 rounded border border-slate-300 px-2 py-1"
              />
              <span className="text-slate-500">{preset.unit}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="ml-auto text-slate-500 hover:text-red-600"
                title="Remove threshold"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StageEditor({
  stages,
  onChange,
}: {
  stages: Stage[];
  onChange: (next: Stage[]) => void;
}) {
  function update(idx: number, patch: Partial<Stage>) {
    onChange(stages.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function remove(idx: number) {
    onChange(stages.filter((_, i) => i !== idx));
  }
  function add() {
    const last = stages[stages.length - 1];
    onChange([...stages, { duration: '1m', target: last?.target ?? 10 }]);
  }
  const peak = stages.reduce((m, s) => Math.max(m, s.target), 0);

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-slate-700">
          Stages <span className="text-xs text-slate-500">(peak {peak} VUs)</span>
        </p>
        <button
          type="button"
          onClick={add}
          className="text-xs text-slate-700 underline hover:text-slate-900"
        >
          + add stage
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {stages.length === 0 && (
          <p className="text-xs text-slate-500">No stages — add at least one.</p>
        )}
        {stages.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-6 text-xs text-slate-500">{i + 1}.</span>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              over
              <input
                value={s.duration}
                onChange={(e) => update(i, { duration: e.target.value })}
                className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                placeholder="30s"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              ramp to
              <input
                type="number"
                min={0}
                max={10000}
                value={s.target}
                onChange={(e) => update(i, { target: Number(e.target.value) })}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
              />
              VUs
            </label>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-xs text-slate-500 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ParamGroup({
  label,
  values,
  hideEmpty,
  onToggleHideEmpty,
  onChange,
}: {
  label: string;
  values: Record<string, string>;
  hideEmpty?: boolean;
  onToggleHideEmpty?: () => void;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(values);
  const visible = hideEmpty ? entries.filter(([, v]) => v !== '') : entries;
  const hiddenCount = entries.length - visible.length;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        {onToggleHideEmpty && hiddenCount > 0 && hideEmpty && (
          <button
            type="button"
            onClick={onToggleHideEmpty}
            className="text-xs text-slate-700 underline hover:text-slate-900"
          >
            + show {hiddenCount} empty
          </button>
        )}
        {onToggleHideEmpty && !hideEmpty && entries.some(([, v]) => v === '') && (
          <button
            type="button"
            onClick={onToggleHideEmpty}
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            hide empty
          </button>
        )}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {visible.map(([name, value]) => (
          <label key={name} className="block">
            <span className="block text-xs text-slate-600">{name}</span>
            <input
              value={value}
              onChange={(e) => onChange({ ...values, [name]: e.target.value })}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function stripEmpty(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== '') out[k] = v;
  return out;
}

function advancedSummary(counts: {
  thresholds: number;
  setup: number;
  teardown: number;
  datasets: number;
}): string {
  const parts: string[] = [];
  if (counts.thresholds) parts.push(`${counts.thresholds} threshold${counts.thresholds === 1 ? '' : 's'}`);
  if (counts.setup) parts.push(`${counts.setup} setup`);
  if (counts.teardown) parts.push(`${counts.teardown} teardown`);
  if (counts.datasets) parts.push(`${counts.datasets} dataset${counts.datasets === 1 ? '' : 's'}`);
  return parts.length > 0
    ? parts.join(' · ')
    : 'thresholds, setup/teardown, datasets';
}

type RerunConfig = {
  runId: string;
  service?: string;
  triggeredBy?: string | null;
  profile: Profile;
  authHeaders?: Record<string, string>;
  execution?:
    | { executor: 'constant-vus'; vus: number; duration: string }
    | { executor: 'ramping-vus'; startVUs: number; stages: Stage[] };
  operations?: Array<{
    method: string;
    path: string;
    pathParams?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
  }>;
  thresholds?: Threshold[];
  setup?: Step[];
  teardown?: Step[];
  datasets?: DatasetInput[];
};

function stringifyValues(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function serializeBody(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  try {
    return JSON.stringify(b, null, 2);
  } catch {
    return '';
  }
}

const METHOD_COLORS: Record<string, string> = {
  get: 'bg-blue-100 text-blue-800 ring-blue-200',
  post: 'bg-green-100 text-green-800 ring-green-200',
  put: 'bg-orange-100 text-orange-800 ring-orange-200',
  patch: 'bg-teal-100 text-teal-800 ring-teal-200',
  delete: 'bg-red-100 text-red-800 ring-red-200',
  head: 'bg-purple-100 text-purple-800 ring-purple-200',
  options: 'bg-slate-100 text-slate-700 ring-slate-200',
};

function MethodBadge({ method }: { method: string }) {
  const cls = METHOD_COLORS[method.toLowerCase()] ?? METHOD_COLORS.options;
  return (
    <span
      className={`inline-block min-w-[4.5rem] rounded px-2 py-0.5 text-center font-mono text-[10px] font-bold uppercase ring-1 ring-inset ${cls}`}
    >
      {method}
    </span>
  );
}
