import Fastify from 'fastify';
import cors from '@fastify/cors';
import { discoverRoute } from './routes/discover.ts';
import { runsRoute } from './routes/runs.ts';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(discoverRoute);
await app.register(runsRoute);

app.get('/health', async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
