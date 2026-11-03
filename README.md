# ocean-mdk-worker

Contract-first MDK worker for the [Ocean.xyz](https://ocean.xyz) Bitcoin mining pool.

`WorkerRuntimeV2` loads this directory. There is no `main`, no `connect()`, and no MiningOS rack boot. Device connection details arrive as `opts`; DATUM credentials arrive as `env` and are not logged.

```json
{
  "apiUrl": "https://api.ocean.xyz",
  "accounts": ["<ocean-username>"],
  "apiRetry": 3,
  "apiRateLimitMs": 1000,
  "datumApiUrl": "http://127.0.0.1:7152"
}
```

`datumApiUrl` is optional. Authenticated DATUM channels need `DATUM_USER` and `DATUM_PASSWORD` in the worker env.

## Declared telemetry

Live: `hashrate`, `workers_online`, `balance`, `estimated_earnings`, `stats`, `workers`, `alerts`, `yearly_balances`.

History, all requiring `start` and `end`: `stats_history`, `workers_count`, `transactions`, `blocks`, `alerts_history`.
`transactions` fetches the whole range from the pool in one call per account; the other history channels are served
from what the Worker has recorded since it started.

`apiRateLimitMs` spaces Ocean API calls (default `1000`, Ocean's rate limit); set it to `0` against the mock.

DATUM: `datum_stats`, `datum_client_stats`, `stratum_info`, `stratum_job`, `thread_stats`, `stratum_list`, `coinbaser`, `datum_config`.

There are no commands. An undeclared query is `ERR_UNKNOWN_QUERY_TYPE`; a history pull without a range is `ERR_START_INVALID` or `ERR_END_INVALID`.

## Develop

```bash
npm install
npm run validate
npm test
npm run mock
```

The mock serves Ocean and DATUM routes on `127.0.0.1:8000`. Point a device at it with `accounts: ["test"]`.

An inactive Ocean username still returns earnings history. Live hashrate and worker endpoints then fail with `ERR_OCEAN_API_ERROR`, and `hashrate` / `workers_online` stay `0`.
