import type { Profile, Stage } from './profiles';

// Relative by default — nginx (in production) and Vite's dev proxy (in dev)
// both forward /api → the API service. Set VITE_API_URL to override with an
// absolute URL during local development without the proxy.
const BASE = import.meta.env.VITE_API_URL ?? '/api';

export type Operation = {
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';
  path: string;
  summary: string;
  parameters: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required: boolean;
    schema: any;
    example: unknown;
  }>;
  requestBody: { contentType: string; schema: any; example: unknown } | null;
};

export type DiscoverResult = {
  specId: string;
  baseUrl: string;
  specUrl: string;
  title: string;
  version: string;
  operations: Operation[];
};

export async function discover(url: string): Promise<DiscoverResult> {
  const res = await fetch(`${BASE}/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

export type RecentSpec = {
  id: string;
  baseUrl: string;
  specUrl: string;
  title: string | null;
  version: string | null;
  fetchedAt: string;
};

export async function listRecentSpecs(): Promise<{ recent: RecentSpec[] }> {
  const res = await fetch(`${BASE}/specs/recent`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteSpec(id: string): Promise<void> {
  const res = await fetch(`${BASE}/specs/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  }
}

export type Threshold = {
  metric: string;
  expression: string;
  abortOnFail?: boolean;
};

export type ExtractBinding = {
  name: string;
  from: 'json' | 'header' | 'status';
  path?: string;
};

export type Step = {
  name?: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  extract?: ExtractBinding[];
};

export type DatasetInput = {
  name: string;
  format: 'json' | 'csv';
  content: string;
};

export type BrowserStep = {
  action: 'goto' | 'click' | 'fill' | 'waitFor' | 'screenshot';
  url?: string;
  selector?: string;
  value?: string;
  timeoutMs?: number;
};

export type TestType = 'http' | 'browser';

export type CreateRunArgs = {
  service: string;
  baseUrl: string;
  triggeredBy?: string;
  authHeaders?: Record<string, string>;
  profile: Profile;
  vus?: number;
  duration?: string;
  stages?: Stage[];
  startVUs?: number;
  operations?: Array<{
    method: string;
    path: string;
    pathParams?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
  }>;
  thresholds?: Threshold[];
  setup?: Step[];
  teardown?: Step[];
  datasets?: DatasetInput[];
  testType?: TestType;
  browserSteps?: BrowserStep[];
  browserIterations?: number;
  browserMaxDuration?: string;
};

export async function createRun(args: CreateRunArgs): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

export async function listRuns() {
  const res = await fetch(`${BASE}/runs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getRun(id: string) {
  const res = await fetch(`${BASE}/runs/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteRun(id: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  }
}

export async function rerunRun(id: string): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/runs/${id}/rerun`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}
