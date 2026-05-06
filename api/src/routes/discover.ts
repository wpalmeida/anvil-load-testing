import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { discoverSpec } from '../lib/openapi.ts';
import { sql } from '../db.ts';
import { isHostAllowed } from '../lib/guards.ts';

const Body = z.object({ url: z.string().url() });

export const discoverRoute: FastifyPluginAsync = async (app) => {
  app.post('/discover', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid body', details: parsed.error.flatten() };
    }
    const guard = isHostAllowed(parsed.data.url);
    if (!guard.ok) {
      reply.code(403);
      return { error: guard.reason };
    }
    try {
      const result = await discoverSpec(parsed.data.url);
      const [row] = await sql`
        INSERT INTO specs (base_url, spec_url, title, version, spec)
        VALUES (${result.baseUrl}, ${result.specUrl}, ${result.title}, ${result.version}, ${sql.json(result.raw)})
        RETURNING id
      `;
      return {
        specId: row.id,
        baseUrl: result.baseUrl,
        specUrl: result.specUrl,
        title: result.title,
        version: result.version,
        operations: result.operations,
      };
    } catch (err) {
      reply.code(422);
      return { error: (err as Error).message };
    }
  });

  // Recent unique base URLs the user has discovered before. Dedups on
  // base_url and returns the latest fetch metadata for each, newest first.
  app.get('/specs/recent', async () => {
    const rows = await sql`
      SELECT id, base_url, spec_url, title, version, fetched_at FROM (
        SELECT DISTINCT ON (base_url)
          id, base_url, spec_url, title, version, fetched_at
        FROM specs
        ORDER BY base_url, fetched_at DESC
      ) s
      ORDER BY fetched_at DESC
      LIMIT 20
    `;
    return { recent: rows };
  });

  app.delete<{ Params: { id: string } }>('/specs/:id', async (req, reply) => {
    // Delete all spec rows that share this row's base_url so the entry
    // disappears from the recent list entirely (not just one fetch).
    const [target] = await sql`SELECT base_url FROM specs WHERE id = ${req.params.id}`;
    if (!target) {
      reply.code(404);
      return { error: 'not found' };
    }
    await sql`DELETE FROM specs WHERE base_url = ${target.baseUrl}`;
    reply.code(204);
    return;
  });
};
