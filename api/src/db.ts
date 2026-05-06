import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// Apply camelCase transform to *column* names only. Using the full
// `postgres.camel` would also transform JSON values, which silently rewrites
// k6 metric keys like `http_reqs` → `httpReqs` inside the run summary.
export const sql = postgres(process.env.DATABASE_URL, {
  transform: { column: postgres.camel.column },
});
