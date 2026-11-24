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

// Get it with its events (newest first)
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
  apiKey: "tk_live_…",                     // default: env TRACKIFIED_API_KEY
  baseURL: "https://api.trackified.net",   // default: env TRACKIFIED_BASE_URL or this
  timeout: 30_000,                         // ms per attempt
  maxRetries: 2,                           // network errors, 408, 429 (honours retry-after), 5xx
  fetch: customFetch,                      // optional
});
```

Every method also takes per-call options: `{ idempotencyKey, signal, timeout, maxRetries }`.
`trackings.create` and `trackings.createBulk` send an `Idempotency-Key` automatically (one per call, reused across its retries) unless you pass your own.

### Resources

| Resource | Methods |
| --- | --- |
| `client.trackings` | `create`, `createBulk`, `list`, `iterate`, `get`, `update`, `delete` (stop tracking), `retrack` |
| `client.carriers` | `list`, `iterate`, `get`, `detect(trackingNumber)`, `search({ q, support, limit })`, `validationStatus` |
| `client.webhooks` | `create` (returns the signing `secret` once), `list`, `iterate`, `delete`, `test`, `verify`, `constructEvent` |
| `client.webhookDeliveries` | `list`, `iterate` |
| `client.apiKeys` | `create`, `list`, `revoke` |
| `client.usage` | `get` |

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
`RateLimitError` (429), `APIError` (5xx), `ConnectionError` (network/timeout), `SignatureVerificationError`.
Other statuses (402 `quota_exceeded`, 409) are plain `TrackifiedError`; check `code`.

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
    if (event.type === "tracking.delivered") console.log("delivered:", event.data.id);
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
});
```

`Trackified.webhooks.verify(rawBody, header, secret, { tolerance })` returns `Promise<boolean>` instead of throwing.
In a Fetch-style handler (Workers, Next.js route handlers, Deno, Bun) pass `await request.text()` as the body.

## License

MIT
