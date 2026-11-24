# trackified

Official TypeScript / JavaScript client for the [Trackified](https://trackified.net) parcel-tracking API.

- Zero runtime dependencies; uses the platform `fetch` and Web Crypto
- Node.js 18+, Deno, Bun and edge runtimes (Cloudflare Workers, Vercel Edge)
- ESM and CommonJS builds with full type declarations
- Retries with backoff, automatic idempotency keys, auto-pagination, typed errors, webhook verification

API reference: <https://forumulate.com/p/trackified/docs> · Webhook signing: <https://trackified.net/developers/webhook-signing>

## Install

```sh
npm install trackified
```

## Quickstart

```ts
import Trackified from "trackified"; // or: const { Trackified } = require("trackified");

const client = new Trackified({ apiKey: process.env.TRACKIFIED_API_KEY }); // apiKey defaults to that env var

// Add a tracking (carrier is detected from the number when you leave it out)
const tracking = await client.trackings.create({
  tracking_number: "9434650110837017316201",
  carrier: "usps",
  custom_id: "order-1001",
});

// Get it with its events (newest first, guaranteed by the API)
const fresh = await client.trackings.get(tracking.id);
console.log(fresh.status, fresh.events[0]?.description);

// List one page...
const page = await client.trackings.list({ status: "in_transit", limit: 50 });
console.log(page.pagination.total);

// ...or iterate every tracking, fetching pages as needed
for await (const t of client.trackings.iterate({ status: "delivered" })) {
  console.log(t.tracking_number, t.delivered_at);
}
```

### Options

```ts
new Trackified({
  apiKey: "live_…",                        // default: env TRACKIFIED_API_KEY
  baseURL: "https://api.trackified.net",   // default: env TRACKIFIED_BASE_URL or this; a trailing /v1 is fine
  timeout: 30_000,                         // ms per attempt
  maxRetries: 2,                           // network errors, 408, 429 (honours retry-after), 5xx
  fetch: customFetch,                      // optional
  onRequest: ({ method, url, attempt, idempotencyKey }) => {},           // optional, once per attempt (from 1)
  onResponse: ({ status, requestId, idempotentReplayed, durationMs, error }) => {}, // optional
});
```

### Hooks

`onRequest` and `onResponse` are called once per attempt, so a retried request calls each of them several times
(`attempt` is 1 for the first try, then 2, 3 ...). `onResponse` gets `status` (undefined when no response arrived), `requestId`
(the `x-request-id` header), `idempotentReplayed` (the `idempotent-replayed` header), `durationMs`, and `error`, the
typed error for a status of 400 or above or a failed connection. An error thrown by a hook is caught and ignored,
so it never breaks the request.

```ts
const client = new Trackified({
  onResponse: (r) => log.info({ method: r.method, url: r.url, status: r.status, requestId: r.requestId, ms: r.durationMs }),
});
```

Every method also takes per-call options: `{ idempotencyKey, signal, timeout, maxRetries }`.
`trackings.create` and `trackings.createBulk` send an `Idempotency-Key` automatically (one per call, reused across its retries) unless you pass your own.

### Resources

| Resource | Methods |
| --- | --- |
| `client.trackings` | `create`, `createBulk`, `list`, `iterate`, `get`, `update`, `delete` (stop tracking), `retrack` |
| `client` | `health()` → `{ status: "ok" }` (no API key needed) |
| `client.carriers` | `list`, `iterate`, `get`, `detect(trackingNumber)`, `resolve(name)`, `search({ q, support, limit })`, `validationStatus` |
| `client.webhooks` | `create` (returns the signing `secret` once), `list`, `iterate`, `update`, `rotateSecret`, `delete`, `test`, `verify`, `verifyDetailed`, `constructEvent`, `trackingOf` |
| `client.webhookDeliveries` | `list`, `iterate` |
| `client.apiKeys` | `create`, `list`, `revoke` |
| `client.usage` | `get` (calls `GET /v1/account/usage`) |

### Carrier names

`carriers.resolve(name)` maps free text or another provider's slug to our carrier id, or returns `null` when the
carrier is unknown or not supported. `trackings.create` accepts the same names directly and stores our id.

```ts
await client.carriers.resolve("USPS Priority Mail"); // { carrier: "usps", name: "USPS", confidence: 0.97, matched: "alias" }
await client.carriers.resolve("royal-mail");          // other providers' slugs work too
await client.trackings.create({ tracking_number: "...", carrier: "FedEx SmartPost" }); // carrier: "fedex"
```

Each `Carrier` has `aliases` and `display_name` (`displayName` is deprecated but still sent).

### Events and times

`events` is newest first. `occurred_at` includes an offset when the carrier gives one (`time_zone_known: true`);
a zoneless `occurred_at` is the local time where the scan happened. `date` is deprecated: it is sent until
2027-06-01 and removed after that.

### Update a webhook

```ts
await client.webhooks.update("wh_123", { enabled: false });
await client.webhooks.update("wh_123", { url: "https://example.com/hooks", eventTypes: ["tracking.delivered"] });
```

The secret does not change. A disabled webhook receives nothing.

### Errors

All errors extend `TrackifiedError` and expose `status`, `code`, `message` and `requestId`:

```ts
import { NotFoundError, RateLimitError, TrackifiedError } from "trackified";

try {
  await client.trackings.get("trk_missing");
} catch (err) {
  if (err instanceof NotFoundError) { /* 404 */ }
  else if (err instanceof RateLimitError) console.log("retry in", err.retryAfter, "s");
  else if (err instanceof TrackifiedError) console.log(err.status, err.code, err.requestId);
}
```

`AuthenticationError` (401), `PermissionError` (403), `NotFoundError` (404), `ValidationError` (400/422),
`QuotaExceededError` (402 `quota_exceeded`), `ConflictError` (409, including `idempotency_in_progress`; not retried),
`RateLimitError` (429), `APIError` (5xx), `ConnectionError` (no response; `code` is `"timeout"` or `"connection"`),
`SignatureVerificationError` (with `reason`).

**After a timeout the outcome is unknown**: the API may have created the tracking. Retry with the same idempotency
key, which the SDK does automatically within `maxRetries`. If you retry yourself later, pass the same
`idempotencyKey` so you get the original result instead of a duplicate.

## Verify a webhook

Trackified signs each delivery with `x-tracking-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`.
Verify against the **raw** request body, not re-serialised JSON. Both helpers are async (Web Crypto).

```ts
import express from "express";
import { Trackified } from "trackified";

const app = express();
app.post("/webhooks/trackified", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await Trackified.webhooks.constructEvent(
      req.body,                                // Buffer
      req.header("x-tracking-signature"),
      process.env.TRACKIFIED_WEBHOOK_SECRET!,
      // { tolerance: 300 }                    // seconds, default 300
    );
    if (event.type === "tracking.status_changed") {
      console.log(event.data.previous_status, "->", event.data.current_status, event.data.tracking.id);
    } else if (event.type === "tracking.delivered") {
      console.log("delivered:", event.data.id); // data is the Tracking
    }
    const tracking = Trackified.webhooks.trackingOf(event); // the Tracking for any event type
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
});
```

The event is a union keyed by `type`: `tracking.status_changed` carries `{ tracking, previous_status, current_status }`,
every other type carries the Tracking.

`Trackified.webhooks.verify(rawBody, header, secret, { tolerance })` returns `Promise<boolean>` instead of throwing.
`Trackified.webhooks.verifyDetailed(...)` returns `{ valid, reason? }`, and a `SignatureVerificationError` has `.reason`:

| reason | meaning |
| --- | --- |
| `missing` | empty or absent header or secret |
| `malformed` | no `t` or no `v1`, non-numeric `t`, bad hex |
| `timestamp` | outside the tolerance |
| `mismatch` | no `v1` matches |

In a Fetch-style handler (Workers, Next.js route handlers, Deno, Bun) pass `await request.text()` as the body.

### Rotating the secret

```ts
const { secret, previous_secret_expires_at } = await client.webhooks.rotateSecret("wh_123", { expiresInHours: 24 });
```

The new secret is shown once. Until `previous_secret_expires_at`, each delivery is signed with both secrets
(`x-tracking-signature: t=…,v1=<new>,v1=<old>`), and a signature is valid if any `v1` matches. So both the old and
the new secret verify during the window, and you can deploy the new one at your own pace. Pass both while you switch:

```ts
await Trackified.webhooks.constructEvent(body, header, [newSecret, oldSecret]);
```

`expiresInHours: 0` drops the old secret at once. `rotateSecret` is not retried automatically: a second rotation
would replace the first new secret before you saw it.

## License

MIT
