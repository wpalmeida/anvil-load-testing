// Parse a HAR (HTTP Archive) file into a DiscoverResult so Anvil's Configure
// page can ingest endpoints recorded from a real browser session. Useful for
// non-OpenAPI apps (Next.js, Rails, etc.) where the user can just browse the
// app once with the Network tab open and export the recording.

import type { DiscoverResult, Operation } from '../api';

const STATIC_EXTENSIONS = [
  '.js', '.css', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.ogg', '.mp3',
];

// Headers we strip from extracted parameters — either secrets we don't want
// baked into the run config, or noise the browser adds that operators don't
// care about.
const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'x-xsrf-token',
]);
const NOISE_HEADERS = new Set([
  'user-agent', 'referer', 'origin', 'accept', 'accept-language',
  'accept-encoding', 'priority', 'host', 'connection', 'cache-control',
  'pragma', 'dnt', 'upgrade-insecure-requests', 'te', 'content-length',
]);

type HarEntry = {
  request: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
    queryString?: Array<{ name: string; value: string }>;
    postData?: { mimeType?: string; text?: string };
  };
  response?: { status?: number };
};

export type ParseHarOptions = {
  filterStatic?: boolean;
  baseUrlOverride?: string;
};

export function parseHar(text: string, opts: ParseHarOptions = {}): DiscoverResult {
  const filterStatic = opts.filterStatic ?? true;

  let har: any;
  try {
    har = JSON.parse(text);
  } catch (err) {
    throw new Error(`HAR file is not valid JSON: ${(err as Error).message}`);
  }

  const entries: HarEntry[] = har?.log?.entries ?? [];
  if (entries.length === 0) {
    throw new Error('HAR contains no entries — was the recording empty?');
  }

  // Determine the dominant origin to use as the base URL (unless the caller
  // pinned one). Cross-origin entries are dropped so the operation list
  // stays focused on the app under test.
  const baseUrl = opts.baseUrlOverride ?? dominantOrigin(entries);

  const seen = new Map<string, Operation>();
  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      continue;
    }
    if (url.origin !== baseUrl) continue;
    if (filterStatic && hasStaticExtension(url.pathname)) continue;

    const method = e.request.method.toLowerCase();
    if (!isHttpMethod(method)) continue;

    const key = `${method} ${url.pathname}`;
    if (seen.has(key)) continue;

    const queryParams = (e.request.queryString ?? []).map((q) => ({
      name: q.name,
      in: 'query' as const,
      required: false,
      schema: { type: 'string' },
      example: q.value,
    }));

    const headerParams = (e.request.headers ?? [])
      .filter((h) => {
        const n = h.name.toLowerCase();
        return !SENSITIVE_HEADERS.has(n) && !NOISE_HEADERS.has(n) && !n.startsWith('sec-');
      })
      .map((h) => ({
        name: h.name,
        in: 'header' as const,
        required: false,
        schema: { type: 'string' },
        example: h.value,
      }));

    let requestBody: Operation['requestBody'] = null;
    const postData = e.request.postData;
    if (postData?.text) {
      let example: unknown = postData.text;
      try {
        example = JSON.parse(postData.text);
      } catch {
        // not JSON, keep the raw text
      }
      requestBody = {
        contentType: postData.mimeType || 'application/json',
        schema: null,
        example,
      };
    }

    seen.set(key, {
      operationId: `${method.toUpperCase()} ${url.pathname}`,
      method: method as Operation['method'],
      path: url.pathname,
      summary: e.response?.status ? `imported (last status ${e.response.status})` : 'imported',
      parameters: [...queryParams, ...headerParams],
      requestBody,
    });
  }

  const operations = [...seen.values()];
  if (operations.length === 0) {
    throw new Error(
      'No usable endpoints in HAR — every entry was filtered as a static asset or cross-origin.',
    );
  }

  const host = new URL(baseUrl).host;
  return {
    specId: `har-${Date.now()}`,
    baseUrl,
    specUrl: 'imported.har',
    title: `${host} (from HAR)`,
    version: '',
    operations,
  };
}

function dominantOrigin(entries: HarEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    try {
      const origin = new URL(e.request.url).origin;
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    } catch {
      // skip malformed URLs
    }
  }
  if (counts.size === 0) {
    throw new Error('HAR contains no parseable URLs');
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function hasStaticExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return STATIC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isHttpMethod(m: string): m is Operation['method'] {
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m);
}
