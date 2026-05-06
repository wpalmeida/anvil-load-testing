# Anvil sample target API

A throwaway HTTP service to demo Anvil with. Boots in a couple seconds,
exposes an OpenAPI spec at `/openapi.json`, and ships four endpoints:

| Method | Path              | Notes |
| ------ | ----------------- | ----- |
| POST   | `/auth/login`     | Returns a fake `access_token` (~40-80ms) |
| GET    | `/things`         | Lists items, supports `?limit=` (~20-60ms) |
| GET    | `/things/{id}`    | Path param; 404 for `id > 1000` (~15-40ms) |
| POST   | `/things`         | Requires `Authorization: Bearer …`; rejects with 401 otherwise (~80-150ms) |

All responses include simulated latency so the Grafana panels look like
real traffic instead of flat lines.

## Running standalone

```bash
cd samples/target-api
npm install
node server.js
```

Hits `http://localhost:8080`.

## Running via the bundled docker-compose

The compose stack exposes this service under the **`sample`** profile, so
it doesn't run by default:

```bash
docker compose --profile sample up --build
```

Inside the docker network the service is reachable at
`http://target-api:8080`. From your browser (where you'll paste the URL into
Anvil's discover form), use the same host — Anvil's API container resolves
it via Docker DNS. From outside Docker, use `http://localhost:8080`.

## A demo run that uses every feature

In the Anvil portal:

1. Discover `http://target-api:8080` → all four operations appear.
2. Pick `GET /things`, `GET /things/{id}`, and `POST /things`.
3. **Datasets**: add `creds` (JSON):
   ```json
   [
     {"username":"alice","password":"pw"},
     {"username":"bob","password":"pw"}
   ]
   ```
4. **Setup steps**: one POST to `/auth/login` with body
   `{"username":"{{creds.username}}","password":"{{creds.password}}"}` and
   extract `name=token, from=json, path=access_token`.
5. **Auth headers**: `Authorization: Bearer {{token}}`.
6. **Thresholds**: `Response time p(95) < 250ms`, `Failure rate < 1%`.
7. **Profile**: load with 20 VUs for 1m.

You'll see Grafana populate, threshold pass/fail badges on the run detail
page, and (because login uses a random row from `creds`) different VUs end
up authenticated as different users.
