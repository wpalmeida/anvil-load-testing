type Operation = {
  method: string;
  path: string;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
};

type Execution =
  | { executor: 'constant-vus'; vus: number; duration: string }
  | {
      executor: 'ramping-vus';
      startVUs: number;
      stages: Array<{ duration: string; target: number }>;
    };

type Threshold = {
  metric: string;
  expression: string;
  abortOnFail?: boolean;
};

type ExtractBinding = {
  name: string;
  from: 'json' | 'header' | 'status';
  path?: string;
};

type Step = {
  name?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  extract?: ExtractBinding[];
};

type Dataset = {
  name: string;
  records: unknown[];
};

export type BrowserStep = {
  action: 'goto' | 'click' | 'fill' | 'waitFor' | 'screenshot';
  url?: string;
  selector?: string;
  value?: string;
  timeoutMs?: number;
};

export type BuildBrowserScriptArgs = {
  runId: string;
  service: string;
  baseUrl: string;
  triggeredBy: string;
  vus: number;
  iterations: number;
  maxDuration: string;
  steps: BrowserStep[];
  thresholds?: Threshold[];
  authHeaders?: Record<string, string>;
};

export function buildBrowserScript(args: BuildBrowserScriptArgs): string {
  const thresholdsBlock = renderThresholds(args.thresholds);
  const stepsCode = args.steps.map((s, i) => renderBrowserStep(s, i)).join('\n    ');

  return `import { browser } from 'k6/browser';

export const options = {
  scenarios: {
    ui: {
      // per-vu-iterations: each VU (= browser tab) runs the flow N times.
      // Total flows = vus * iterations. Picked over shared-iterations
      // because the latter requires iterations >= vus and gives uneven
      // per-VU work distribution.
      executor: 'per-vu-iterations',
      vus: ${args.vus},
      iterations: ${args.iterations},
      maxDuration: ${JSON.stringify(args.maxDuration)},
      options: {
        browser: { type: 'chromium' },
      },
    },
  },
  tags: {
    run_id: ${JSON.stringify(args.runId)},
    service: ${JSON.stringify(args.service)},
    triggered_by: ${JSON.stringify(args.triggeredBy)},
    test_type: 'browser',
  },${thresholdsBlock}
};

const BASE_URL = ${JSON.stringify(args.baseUrl)};
const AUTH_HEADERS = ${JSON.stringify(args.authHeaders ?? {})};

export default async function () {
  const page = await browser.newPage();
  try {
    // Apply auth headers to every request Chromium makes during this flow.
    if (Object.keys(AUTH_HEADERS).length > 0) {
      await page.setExtraHTTPHeaders(AUTH_HEADERS);
    }
    ${stepsCode}
  } catch (e) {
    console.error('browser step failed: ' + (e && e.message ? e.message : String(e)));
    throw e;
  } finally {
    await page.close();
  }
}
`;
}

function renderBrowserStep(step: BrowserStep, idx: number): string {
  const timeout = step.timeoutMs ? `, { timeout: ${step.timeoutMs} }` : '';
  switch (step.action) {
    case 'goto': {
      const url = step.url || '';
      // Resolve relative URLs against BASE_URL.
      const target = url.startsWith('http') ? JSON.stringify(url) : `BASE_URL + ${JSON.stringify(url)}`;
      return `// step ${idx + 1}: goto\n    await page.goto(${target}${timeout});`;
    }
    case 'click':
      return `// step ${idx + 1}: click ${step.selector ?? ''}\n    await page.locator(${JSON.stringify(step.selector ?? '')}).click(${timeout ? `{ timeout: ${step.timeoutMs} }` : ''});`;
    case 'fill':
      return `// step ${idx + 1}: fill ${step.selector ?? ''}\n    await page.locator(${JSON.stringify(step.selector ?? '')}).fill(${JSON.stringify(step.value ?? '')}${timeout ? `, { timeout: ${step.timeoutMs} }` : ''});`;
    case 'waitFor':
      return `// step ${idx + 1}: waitFor ${step.selector ?? ''}\n    await page.locator(${JSON.stringify(step.selector ?? '')}).waitFor({ state: 'visible'${step.timeoutMs ? `, timeout: ${step.timeoutMs}` : ''} });`;
    case 'screenshot':
      return `// step ${idx + 1}: screenshot\n    await page.screenshot({ path: ${JSON.stringify(`/tmp/anvil-step-${idx + 1}.png`)} });`;
    default:
      return `// unknown step ${idx + 1}`;
  }
}

export type BuildScriptArgs = {
  runId: string;
  service: string;
  baseUrl: string;
  execution: Execution;
  operations: Operation[];
  triggeredBy: string;
  thresholds?: Threshold[];
  setup?: Step[];
  teardown?: Step[];
  datasets?: Dataset[];
};

export function buildScript(args: BuildScriptArgs): string {
  const operationsLiteral = JSON.stringify(args.operations, null, 2);
  const setupLiteral = JSON.stringify(args.setup ?? [], null, 2);
  const teardownLiteral = JSON.stringify(args.teardown ?? [], null, 2);
  const datasetsLiteral = renderDatasets(args.datasets);
  const scenario = renderScenario(args.execution);
  const thresholdsBlock = renderThresholds(args.thresholds);

  return `import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

export const options = {
  scenarios: {
    main: ${scenario},
  },
  tags: {
    run_id: ${JSON.stringify(args.runId)},
    service: ${JSON.stringify(args.service)},
    triggered_by: ${JSON.stringify(args.triggeredBy)},
  },${thresholdsBlock}
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const BASE_URL = ${JSON.stringify(args.baseUrl)};
const AUTH_HEADERS = (function () {
  try { return JSON.parse(__ENV.AUTH_HEADERS || '{}'); } catch (e) { return {}; }
})();
const OPERATIONS = ${operationsLiteral};
const SETUP_STEPS = ${setupLiteral};
const TEARDOWN_STEPS = ${teardownLiteral};

${datasetsLiteral}

// Look up a possibly nested key like "users.email" inside ctx.
function getNested(ctx, key) {
  if (!ctx) return undefined;
  if (key.indexOf('.') === -1) return ctx[key];
  const parts = key.split('.');
  let cur = ctx;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// Substitute {{name}} or {{dataset.field}} with values from ctx.
function interpolate(s, ctx) {
  if (typeof s !== 'string') return s;
  return s.replace(/\\{\\{([\\w.]+)\\}\\}/g, function (_, k) {
    const v = getNested(ctx, k);
    return v !== undefined && v !== null ? String(v) : '';
  });
}

function interpolateObject(obj, ctx) {
  if (!obj) return {};
  const out = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = interpolate(obj[keys[i]], ctx);
  return out;
}

// Auth headers are defaults; per-operation headers override on conflict.
// Both run through interpolation against the setup context.
function buildHeaders(extra, ctx) {
  return interpolateObject(Object.assign({}, AUTH_HEADERS, extra || {}), ctx);
}

function interpolatePath(path, params) {
  let out = path;
  if (!params) return out;
  const ks = Object.keys(params);
  for (let i = 0; i < ks.length; i++) {
    out = out.replace('{' + ks[i] + '}', encodeURIComponent(String(params[ks[i]])));
  }
  return out;
}

function buildQuery(params) {
  if (!params) return '';
  const parts = [];
  const ks = Object.keys(params);
  for (let i = 0; i < ks.length; i++) {
    const v = params[ks[i]];
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(ks[i]) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// Run a single setup/teardown step, populate ctx with extracted values.
function runStep(step, ctx, phase) {
  const rawUrl = step.url.indexOf('http') === 0 ? step.url : BASE_URL + step.url;
  const url = interpolate(rawUrl, ctx);
  const headers = interpolateObject(step.headers || {}, ctx);
  let body = null;
  if (step.body) {
    body = interpolate(step.body, ctx);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  const tag = (step.name || step.method.toUpperCase() + ' ' + step.url);
  let res;
  try {
    res = http.request(step.method.toUpperCase(), url, body, {
      headers: headers,
      tags: { phase: phase, step: tag },
    });
  } catch (e) {
    console.error('[' + phase + '] step "' + tag + '" failed: ' + (e && e.message ? e.message : e));
    throw e;
  }
  if (res.status < 200 || res.status >= 400) {
    console.error('[' + phase + '] step "' + tag + '" returned status ' + res.status);
  }
  if (step.extract) {
    for (let i = 0; i < step.extract.length; i++) {
      const e = step.extract[i];
      let value;
      if (e.from === 'json') value = e.path ? res.json(e.path) : res.json();
      else if (e.from === 'header') value = e.path ? res.headers[e.path] : undefined;
      else if (e.from === 'status') value = res.status;
      ctx[e.name] = value;
    }
  }
  // Auto-capture Set-Cookie cookies from setup/teardown responses so the
  // VU's cookie jar can replay them per-iteration during the load phase.
  // Handles session-cookie auth (NextAuth, Django, Rails, Laravel) without
  // any explicit extract binding.
  if (res.cookies) {
    ctx._cookies = ctx._cookies || [];
    const seen = {};
    for (let i = 0; i < ctx._cookies.length; i++) {
      seen[ctx._cookies[i].name + '|' + (ctx._cookies[i].domain || '')] = true;
    }
    const names = Object.keys(res.cookies);
    for (let i = 0; i < names.length; i++) {
      const arr = res.cookies[names[i]];
      for (let j = 0; j < arr.length; j++) {
        const c = arr[j];
        const key = c.name + '|' + (c.domain || '');
        if (seen[key]) continue;
        seen[key] = true;
        ctx._cookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain || '',
          path: c.path || '/',
        });
      }
    }
  }
  return res;
}

export function setup() {
  const ctx = {};
  for (let i = 0; i < SETUP_STEPS.length; i++) runStep(SETUP_STEPS[i], ctx, 'setup');
  return ctx;
}

export function teardown(data) {
  const ctx = Object.assign({}, data || {});
  for (let i = 0; i < TEARDOWN_STEPS.length; i++) runStep(TEARDOWN_STEPS[i], ctx, 'teardown');
}

// Pick one record per dataset for this iteration so all operations within
// the same iteration see the same row (e.g., create-user → read-user).
function buildIterationCtx(setupCtx) {
  const ctx = Object.assign({}, setupCtx || {});
  const names = Object.keys(DATASETS);
  for (let i = 0; i < names.length; i++) {
    const arr = DATASETS[names[i]];
    if (arr.length === 0) continue;
    ctx[names[i]] = arr[Math.floor(Math.random() * arr.length)];
  }
  return ctx;
}

// Replay setup-captured cookies into this VU's jar before the load phase.
// Cookies are scoped to the URL passed to jar.set(); BASE_URL covers the
// common same-origin case (login + API requests share an origin).
function restoreCookies(ctx) {
  if (!ctx || !ctx._cookies || ctx._cookies.length === 0) return;
  const jar = http.cookieJar();
  for (let i = 0; i < ctx._cookies.length; i++) {
    const c = ctx._cookies[i];
    try {
      jar.set(BASE_URL, c.name, c.value, { path: c.path });
    } catch (e) {
      // Some attributes (Secure, SameSite) may reject; silently skip.
    }
  }
}

export default function (data) {
  const ctx = buildIterationCtx(data);
  restoreCookies(ctx);
  for (let i = 0; i < OPERATIONS.length; i++) {
    const op = OPERATIONS[i];
    const url = BASE_URL + interpolatePath(op.path, op.pathParams) + buildQuery(op.queryParams);
    const headers = buildHeaders(op.headers, ctx);
    let body = null;
    if (op.body !== undefined && op.body !== null) {
      const bodyRaw = typeof op.body === 'string' ? op.body : JSON.stringify(op.body);
      body = interpolate(bodyRaw, ctx);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const tag = op.method.toUpperCase() + ' ' + op.path;
    try {
      const res = http.request(op.method.toUpperCase(), url, body, {
        headers: headers,
        // phase: 'load' lets dashboards exclude setup/teardown traffic
        // (which is tagged 'setup' / 'teardown' by runStep above).
        tags: { operation: tag, phase: 'load' },
      });
      check(res, {
        'status is 2xx': (r) => r.status >= 200 && r.status < 300,
      });
    } catch (e) {
      console.error('request failed for ' + tag + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  sleep(1);
}
`;
}

function renderDatasets(datasets?: Dataset[]): string {
  if (!datasets || datasets.length === 0) {
    return 'const DATASETS = {};';
  }
  // Each SharedArray must be created at module init from a function. We
  // bake the records inline; SharedArray dedups them across VUs in memory.
  const lines = datasets.map((d) => {
    const json = JSON.stringify(d.records);
    return `  ${JSON.stringify(d.name)}: new SharedArray(${JSON.stringify(d.name)}, function () { return ${json}; }),`;
  });
  return `const DATASETS = {\n${lines.join('\n')}\n};`;
}

function renderThresholds(thresholds?: Threshold[]): string {
  if (!thresholds || thresholds.length === 0) return '';
  const grouped: Record<string, string[]> = {};
  for (const t of thresholds) {
    grouped[t.metric] ??= [];
    if (t.abortOnFail) {
      grouped[t.metric].push(
        `{ threshold: ${JSON.stringify(t.expression)}, abortOnFail: true }`,
      );
    } else {
      grouped[t.metric].push(JSON.stringify(t.expression));
    }
  }
  const lines = Object.entries(grouped).map(
    ([metric, items]) => `    ${JSON.stringify(metric)}: [${items.join(', ')}],`,
  );
  return `\n  thresholds: {\n${lines.join('\n')}\n  },`;
}

function renderScenario(exec: Execution): string {
  if (exec.executor === 'constant-vus') {
    return `{
      executor: 'constant-vus',
      vus: ${exec.vus},
      duration: ${JSON.stringify(exec.duration)},
    }`;
  }
  const stages = exec.stages
    .map((s) => `        { duration: ${JSON.stringify(s.duration)}, target: ${s.target} }`)
    .join(',\n');
  return `{
      executor: 'ramping-vus',
      startVUs: ${exec.startVUs},
      stages: [
${stages}
      ],
    }`;
}
