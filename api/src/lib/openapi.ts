import YAML from 'yaml';

const PROBE_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/v3/api-docs',
  '/api-docs',
  '/docs/openapi.json',
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

export type DiscoveredOperation = {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  parameters: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required: boolean;
    schema: any;
    example: unknown;
  }>;
  requestBody: {
    contentType: string;
    schema: any;
    example: unknown;
  } | null;
};

export type DiscoveredSpec = {
  baseUrl: string;
  specUrl: string;
  title: string;
  version: string;
  operations: DiscoveredOperation[];
  raw: any;
};

export async function discoverSpec(input: string): Promise<DiscoveredSpec> {
  const url = new URL(input);
  const candidates =
    url.pathname && url.pathname !== '/'
      ? [input, ...PROBE_PATHS.map((p) => new URL(p, url).toString())]
      : PROBE_PATHS.map((p) => new URL(p, url).toString());

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { Accept: 'application/json, text/yaml, */*' } });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseSpec(text);
      if (!parsed?.paths) continue;
      const baseUrl = pickBaseUrl(parsed, url);
      return {
        baseUrl,
        specUrl: candidate,
        title: parsed.info?.title ?? url.host,
        version: parsed.info?.version ?? '',
        operations: extractOperations(parsed),
        raw: parsed,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not discover an OpenAPI/Swagger spec from ${input}. Probed: ${candidates.join(', ')}. Last error: ${
      (lastErr as Error)?.message ?? 'none'
    }`,
  );
}

function parseSpec(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return YAML.parse(text);
  }
}

function pickBaseUrl(spec: any, sourceUrl: URL): string {
  const fromServers = spec.servers?.[0]?.url;
  if (fromServers) {
    try {
      // Resolve relative server URLs against the source URL
      return new URL(fromServers, sourceUrl).toString().replace(/\/$/, '');
    } catch {
      // fall through
    }
  }
  return `${sourceUrl.protocol}//${sourceUrl.host}`;
}

function extractOperations(spec: any): DiscoveredOperation[] {
  const out: DiscoveredOperation[] = [];
  const paths = spec.paths ?? {};
  for (const [path, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams: any[] = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const params = [...pathParams, ...(op.parameters ?? [])].map(normalizeParam);
      out.push({
        operationId: op.operationId ?? `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary ?? op.description ?? '',
        parameters: params,
        requestBody: normalizeRequestBody(op.requestBody),
      });
    }
  }
  return out;
}

function normalizeParam(p: any) {
  return {
    name: p.name,
    in: p.in,
    required: !!p.required,
    schema: p.schema ?? { type: p.type },
    example: p.example ?? p.schema?.example,
  };
}

function normalizeRequestBody(body: any) {
  if (!body?.content) return null;
  const [contentType, media] =
    Object.entries<any>(body.content).find(([ct]) => ct.includes('json')) ??
    Object.entries<any>(body.content)[0] ??
    [];
  if (!contentType) return null;
  return {
    contentType,
    schema: media?.schema ?? null,
    example: media?.example ?? media?.schema?.example ?? null,
  };
}
