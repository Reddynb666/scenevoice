# SceneVoice Cloud relay

A metered proxy in front of Gemini (and DashScope for mainland China) so the SceneVoice extension can describe a video for someone who has not made an API key. It runs as one Cloudflare Worker with four KV namespaces.

What it is not: there are no user accounts, no passwords and no custody of anyone's key. A device gets an anonymous token; the token has a plan and a daily allowance in seconds of video; finished descriptions go into a shared text cache. The operator's own Gemini key lives in a Worker secret and is only ever put in the request header to Google.

The extension side is the `cloud` provider in `src/shared/` (constant `CLOUD_API_BASE` in `src/shared/constants.js`, currently `https://api.scenevoice.app`, to be changed to the domain the owner registers). Both sides implement protocol v1 below; change it in both places or not at all.

Privacy commitments are in [PRIVACY-ADDENDUM.md](PRIVACY-ADDENDUM.md) (English and Chinese), which the extension's `PRIVACY.md` links to.

## Layout

```
server/
  src/worker.js        routes, auth, allowance, proxying, cache, licences, Stripe webhook
  src/store.js         the only file that touches KV (swap for D1 here)
  src/util.js          error shapes, UTC days, random ids, hashing, CORS
  src/stripe.js        Stripe-Signature check with Web Crypto
  scripts/make-license.mjs   prints a licence key for invoice customers
  test/*.test.js       vitest, with an in-memory KV and a stubbed fetch
  wrangler.toml        bindings and vars, commented
  package.json         wrangler only; the tests use the repository's vitest
```

## Protocol v1

Base URL: `CLOUD_API_BASE`. Plain JSON only; no streaming. Request bodies up to 20 MB (the extension sends up to six 640-pixel JPEG frames per request). Upstream calls time out after 300 s.

The device token is the only credential. It is sent as `x-goog-api-key: <token>` (so the extension's `GeminiClient` works unchanged with `apiBase = CLOUD_API_BASE` and `apiKey = token`) or as `Authorization: Bearer <token>` (so `QwenClient` does too). The extension stores it like an API key: `chrome.storage.local`, trusted contexts only.

Errors use Google's JSON shape on `/v1beta/*` and on the relay's own `/v1/*` routes, and OpenAI's shape on `/compatible-mode/*`, so the extension's `classifyHttp` / `classifyQwenHttp` keep working. Relay-made errors carry a `details[0].reason` (Google style) or `type` (OpenAI style) starting with `SCENEVOICE_` / `scenevoice_`:

| reason | when |
| --- | --- |
| `SCENEVOICE_DEVICE_UNKNOWN` (401) | no token, malformed token, or a token the relay does not know: register again |
| `SCENEVOICE_DEVICE_LIMIT` (429) | too many new devices from one network address today |
| `SCENEVOICE_ALLOWANCE` (429) | today's seconds are used up; the extension maps this to its own error code `allowance`, not `quota` |
| `SCENEVOICE_MODEL_NOT_ALLOWED` (404) | a free device asked for a model outside `FREE_MODELS` |
| `SCENEVOICE_SCRIPT_NOT_FOUND` (404), `SCENEVOICE_SCRIPT_INVALID` (400) | shared cache |
| `SCENEVOICE_LICENCE_NOT_FOUND` (404), `SCENEVOICE_LICENCE_FULL` (409) | licences |
| `SCENEVOICE_UPSTREAM_TIMEOUT` (504), `SCENEVOICE_UPSTREAM_UNREACHABLE` (502) | the model did not answer |
| `SCENEVOICE_NOT_CONFIGURED` (501) | the deployment lacks the secret that route needs |
| `SCENEVOICE_ORIGIN` (403) | a web origin not in `ALLOWED_ORIGINS` |

Every authenticated response (and every proxied one) carries `x-scenevoice-plan`, `x-scenevoice-used-today`, `x-scenevoice-seconds-per-day` and `x-scenevoice-resets-at`. CORS exposes them.

### Devices

`POST /v1/devices` body `{"client":"extension","version":"1.1.0","locale":"en"}` (all optional strings) → `201 {"token":"svd_<32 hex>","plan":"free","allowance":{"secondsPerDay":3600,"usedToday":0,"resetsAt":"<ISO>"}}`. Anonymous. Limited per network address per UTC day (`DEVICES_PER_IP_PER_DAY`, default 20) using a hash of the address salted with the day; the address is not stored.

`GET /v1/me` with the token → `{"plan":"free"|"plus"|"org","allowance":{...},"cacheHits":n}`.

### Gemini-compatible proxy

`GET /v1beta/models?pageSize=…&pageToken=…` → forwarded to Gemini with the server's key. For free devices the list is filtered to `FREE_MODELS` (default `^gemini-\d(\.\d)?-flash(-lite)?`: the flash and flash-lite families); Plus and organisation devices see every model Google returns (the extension drops the ones that cannot read video).

`POST /v1beta/models/{model}:generateContent` → the relay checks the allowance for today, refuses with the 429 below if `usedToday >= secondsPerDay`, otherwise forwards the bytes unchanged with the server's key. After a successful answer it charges `ceil(usageMetadata.promptTokenCount / 100)` seconds (about 100 tokens per second of video at low resolution; pictures and text count the same way), then returns the upstream status and body unchanged plus the `x-scenevoice-*` headers. An upstream error (any 4xx/5xx) is passed through unchanged and charges nothing. A free device asking for a model outside `FREE_MODELS` gets a 404 before anything is forwarded.

Allowance used up:

```json
{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"SceneVoice allowance for today is used up",
  "details":[{"reason":"SCENEVOICE_ALLOWANCE","resetsAt":"2026-11-05T00:00:00.000Z","plan":"free"}]}}
```

### Qwen-compatible proxy (mainland China)

`POST /compatible-mode/v1/chat/completions` with `Authorization: Bearer <token>` → forwarded to DashScope with the server's key (`DASHSCOPE_API_KEY`; without it the route answers 501). Charged by `usage.prompt_tokens / 100` the same way. The same 429 in OpenAI style:

```json
{"error":{"message":"SceneVoice allowance for today is used up","type":"scenevoice_allowance","code":"allowance","resetsAt":"2026-11-05T00:00:00.000Z"}}
```

A successful upstream answer whose token count the relay cannot read (for example a stream, which the extension never asks for) is charged `UNMETERED_RESPONSE_SECONDS` (default 120) so nothing is free by accident.

### Shared description cache

Text only, never pictures, never who asked.

`GET /v1/scripts/{videoId}?lang=<code>&v=<SCRIPT_VERSION>` → `200` the script JSON (the shape the extension saves in `chrome.storage.local`, with `"source":"cloud"` added) or `404`. A token is optional; with one, the hit is counted for `GET /v1/me`.

`PUT /v1/scripts/{videoId}?lang=<code>` with the token, body = a complete script → `204`. Stored only if `complete` is `true` and it validates: integer `version`, `cues` array where each cue has a non-negative `start` and a `standard` text, every string at most 2000 characters, `videoId` and `lang` matching the address when present. Unknown fields are dropped, so a picture cannot ride along. Size cap 512 KB, TTL 180 days, key `videoId:lang:version`. Does not count against the allowance. The extension sends it only when the setting `shareDescriptions` is on (default on with the cloud provider, off otherwise) and after a job completes.

### Licences

`POST /v1/licenses/activate` body `{"licenseKey":"svl-XXXX-XXXX-XXXX"}` with the token → `{"plan":"plus"|"org","allowance":{...}}`, or `404` for an unknown or malformed key, or `409` when all seats are taken. Activating the same key again from the same device takes no extra seat. Keys come from the Stripe webhook or from `scripts/make-license.mjs`.

### Operator routes

- `GET /` one line of text pointing here; `GET /healthz` → `ok`.
- `POST /webhooks/stripe` and `GET /admin/licenses/{session_id}`: see Stripe below.

## Deployment

Needs a Cloudflare account on the Workers Paid plan: the free plan's KV limit of 1000 writes a day and 10 ms of CPU per request are not enough for real use. Node 18 or newer locally.

```sh
cd server
npm install                      # wrangler only
npx wrangler login

# 1. storage
npx wrangler kv namespace create DEVICES
npx wrangler kv namespace create USAGE
npx wrangler kv namespace create SCRIPTS
npx wrangler kv namespace create LICENSES
#    paste the four ids into wrangler.toml

# 2. secrets
npx wrangler secret put GEMINI_API_KEY          # required
npx wrangler secret put DASHSCOPE_API_KEY       # mainland China only
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # when Stripe is set up
npx wrangler secret put ADMIN_TOKEN             # for GET /admin/licenses/…; e.g. `openssl rand -hex 32`

# 3. settings: edit [vars] in wrangler.toml (allowances, ALLOWED_ORIGINS, FREE_MODELS)

# 4. deploy
npm run deploy
```

Custom domain: put the zone on Cloudflare, uncomment `routes` in `wrangler.toml` with the host you chose, deploy again, and set `CLOUD_API_BASE` in `src/shared/constants.js` to `https://<that host>` (the extension's manifest takes its host permission from the same constant). The relay serves no HTML, so the apex can stay on the project site.

Smoke test:

```sh
curl -s https://api.scenevoice.app/healthz
TOKEN=$(curl -s -X POST https://api.scenevoice.app/v1/devices -H 'content-type: application/json' -d '{"client":"curl"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s https://api.scenevoice.app/v1/me -H "x-goog-api-key: $TOKEN"
curl -s "https://api.scenevoice.app/v1beta/models?pageSize=50" -H "x-goog-api-key: $TOKEN" | head -c 600
```

Local development: `npm run dev` starts the Worker at `http://localhost:8787` with local KV; put the secrets in `server/.dev.vars` (`GEMINI_API_KEY=…`, git-ignored by `server/.gitignore`) and point the extension's `CLOUD_API_BASE` at it for a test build.

Tests run with the repository's vitest, from the repository root:

```sh
npx vitest run server/test      # or: npm test (runs everything)
```

The root vitest configuration is the default one, whose include pattern already matches `server/test/*.test.js`; `npm test` at the root runs them with the extension's tests.

## Cost model

Gemini prices as of 2026-11-04 (input / output per million tokens): Gemini 3.8 Flash $0.75 / $3.75; Gemini 3.5 Flash-Lite $0.30 / $2.50. SceneVoice sends video at low resolution, about 100 tokens per second, so one hour of video is about 360 000 input tokens plus roughly 10 000 to 20 000 output tokens for the script:

| model | one hour of new descriptions |
| --- | --- |
| 3.5 Flash-Lite | about $0.11 ($0.108 input + $0.03 to $0.05 output) |
| 3.8 Flash | about $0.30 to $0.35 ($0.27 input + $0.04 to $0.08 output) |

So a free device that uses its whole hour every day costs the operator $0.11 to $0.35 a day, and most devices use far less. The shared cache means a popular video is generated once; the Worker itself costs $5 a month plus fractions of a cent per million requests and KV operations. Google raises Gemini 3.x Flash prices on 2027-01-01; the default `FREE_MODELS` keeps free devices on the flash and flash-lite families, and the extension prefers flash-lite when it is available.

Qwen (`qwen3-vl-plus`) at October 2026 prices is about ¥2 per hour of video; see `README.zh-CN.md`.

## Mainland China deployment

The same Worker code, different plumbing:

- Set `DASHSCOPE_API_KEY`; the extension's China build uses `/compatible-mode/v1/chat/completions`. `DASHSCOPE_API_BASE` can point at the per-workspace address Alibaba Cloud now recommends.
- Cloudflare Workers are not reliably reachable from mainland China. Host the relay on a Chinese provider (Alibaba Cloud Function Compute or an ECS instance behind Nginx) under a domain with an ICP filing (ICP 备案); the Worker uses only standard `fetch`, `Request`, `Response`, Web Crypto and the four store functions, so a port means replacing `src/store.js` (Redis or a database) and a thin HTTP adapter.
- Read the compliance section of `README.zh-CN.md` (生成式人工智能服务备案, PIPL consent for pictures leaving the device, content labelling) before taking paying users. Payments in China go through WeChat Pay or Alipay, which need a registered business entity; the licence-key route (`/v1/licenses/activate`) is payment-provider neutral, so a Chinese checkout only has to create licence records in the same shape.

## Stripe (owner to finish)

The code handles exactly this much, marked `OWNER TO FINISH` in `src/worker.js`:

1. The owner creates Stripe Products and Prices for Plus (monthly / yearly) and organisation seats, and Checkout sessions with `metadata.plan` = `plus` or `org` and `metadata.seats` (default 1).
2. A webhook endpoint pointing at `https://<host>/webhooks/stripe` for `checkout.session.completed` (and `checkout.session.async_payment_succeeded` for delayed payment methods). Its signing secret goes into `STRIPE_WEBHOOK_SECRET`. The Worker verifies `Stripe-Signature` (HMAC-SHA256 of `t.body`, 5-minute tolerance) with Web Crypto; no Stripe SDK.
3. On a paid session the Worker creates a key `svl-XXXX-XXXX-XXXX`, stores `{plan, seats, used: 0, created, session}`, and answers `{"received":true,"licenseKey":"svl-…","plan":"plus","seats":1}`. A retried webhook gets the same key.
4. Delivering the key is the owner's part: the Checkout success page (on the owner's site, server side) calls `GET /admin/licenses/{CHECKOUT_SESSION_ID}` with `Authorization: Bearer <ADMIN_TOKEN>` and shows or emails the key. Never expose `ADMIN_TOKEN` to a browser.
5. Refunds, cancellations and seat changes are not automated: delete or edit the licence record with `wrangler kv key …` (the key's record is at `LICENSES/<key>`, the session index at `LICENSES/session:<id>`).

Invoice customers (schools, libraries): `node server/scripts/make-license.mjs --plan org --seats 30 --note "Example School"` prints a key and the `wrangler kv key put` command that stores it.

## Privacy commitments

- The cache stores text only: timestamps, sentences, language, video id, model name. No frames, no questions, no answers to questions, nothing about who uploaded it.
- Request bodies are forwarded as bytes and never parsed, stored or logged. Responses are parsed only to read the token count.
- One log line per request: route template, status, first 8 characters of the token, seconds charged. No addresses, no video ids, no bodies.
- Device records hold a plan, a creation date and a licence key. Registration limits use a one-day hash of the network address salted with the date.
- The operator's upstream keys appear only in the request header to the upstream; tests assert they are in no response body, header or stored value.
- No analytics, no advertising identifiers, no selling of data, no accessibility feature behind the paywall. The BYOK path never degrades.

## Known limits

- KV has no atomic increment: two requests in the same second can both read the old total, so an allowance can be overshot by one request. D1 or a Durable Object fixes this; `src/store.js` is the one file to change.
- A device that changes licence keys keeps its seat on the old key until the owner edits the record.
- There is no way to delete a device token server side except with `wrangler kv key delete --binding DEVICES <token>`.
