// A tiny target API people can point Anvil at to try the platform without
// their own service. Three resources, one auth endpoint, simulated latency
// so the latency panels in Grafana look interesting.
import express from 'express';

const app = express();
app.use(express.json());

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Anvil sample target', version: '0.1.0' },
  servers: [{ url: 'http://target-api:8080' }],
  paths: {
    '/auth/login': {
      post: {
        summary: 'Get a fake bearer token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'demo' },
                  password: { type: 'string', example: 'demo' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/things': {
      get: {
        summary: 'List things',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', example: 20 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Create a thing (requires Bearer auth)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'widget' },
                  qty: { type: 'integer', example: 1 },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/things/{id}': {
      get: {
        summary: 'Get a thing by id',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 1 } },
        ],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Not found' },
        },
      },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (low, high) => low + Math.random() * (high - low);

app.get('/openapi.json', (_req, res) => res.json(SPEC));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/auth/login', async (req, res) => {
  await sleep(jitter(40, 80));
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  res.json({
    access_token: `demo-${Buffer.from(username).toString('base64')}`,
    expires_in: 3600,
  });
});

app.get('/things', async (req, res) => {
  await sleep(jitter(20, 60));
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const items = Array.from({ length: limit }, (_, i) => ({
    id: i + 1,
    name: `thing-${i + 1}`,
  }));
  res.json({ items });
});

app.get('/things/:id', async (req, res) => {
  await sleep(jitter(15, 40));
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: 'bad id' });
  }
  if (id > 1000) return res.status(404).json({ error: 'not found' });
  res.json({ id, name: `thing-${id}` });
});

app.post('/things', async (req, res) => {
  await sleep(jitter(80, 150));
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'auth required' });
  }
  const { name, qty } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.status(201).json({ id: Math.floor(Math.random() * 100000), name, qty: qty ?? 1 });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => {
  console.log(`anvil sample target listening on :${port}`);
});
