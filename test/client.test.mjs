import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Trackified, {
  APIError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  TrackifiedError,
  ValidationError,
  VERSION,
} from "../dist/esm/index.js";
import { mockFetch } from "./helpers.mjs";

const make = (responses, opts = {}) => {
  const fetch = mockFetch(responses);
  return { fetch, client: new Trackified({ apiKey: "tk_test_x", fetch, ...opts }) };
};
const tracking = { id: "trk_1", tracking_number: "1Z", status: "in_transit", events: [] };

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(VERSION, pkg.version);
});

test("requires an api key, falls back to env", () => {
  const saved = process.env.TRACKIFIED_API_KEY;
  delete process.env.TRACKIFIED_API_KEY;
  assert.throws(() => new Trackified(), TrackifiedError);
  process.env.TRACKIFIED_API_KEY = "tk_test_env";
  assert.ok(new Trackified({ fetch: mockFetch([]) }));
  if (saved === undefined) delete process.env.TRACKIFIED_API_KEY;
  else process.env.TRACKIFIED_API_KEY = saved;
});

test("create sends auth, user agent, body and an idempotency key", async () => {
  const { fetch, client } = make([{ status: 201, body: tracking }]);
  const t = await client.trackings.create({ tracking_number: "1Z", carrier: "ups" });
  assert.equal(t.id, "trk_1");
  const [c] = fetch.calls;
  assert.equal(c.method, "POST");
  assert.equal(c.url.href, "https://api.trackified.net/v1/trackings");
  assert.equal(c.headers.authorization, "Bearer tk_test_x");
  assert.equal(c.headers["user-agent"], `trackified-node/${VERSION}`);
  assert.match(c.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(c.body), { tracking_number: "1Z", carrier: "ups" });
});

test("idempotency key is reused across retries and can be passed in", async () => {
  const { fetch, client } = make(
    [
      { status: 503, body: {} },
      { status: 201, body: tracking },
    ],
    {},
  );
  await client.trackings.create({ tracking_number: "1Z" }, { idempotencyKey: "my-key" });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].headers["idempotency-key"], "my-key");
  assert.equal(fetch.calls[1].headers["idempotency-key"], "my-key");

  const m = make([
    { status: 500, body: {} },
    { status: 201, body: tracking },
  ]);
  await m.client.trackings.createBulk([{ tracking_number: "1Z" }]);
  const k = m.fetch.calls[0].headers["idempotency-key"];
  assert.ok(k);
  assert.equal(m.fetch.calls[1].headers["idempotency-key"], k);
});

test("GET requests carry no idempotency key; query params are encoded", async () => {
  const { fetch, client } = make([{ body: { data: [], pagination: { limit: 10, offset: 0, total: 0 } } }]);
  await client.trackings.list({ status: "delivered", limit: 10, carrier: undefined });
  const [c] = fetch.calls;
  assert.equal(c.headers["idempotency-key"], undefined);
  assert.equal(c.url.search, "?status=delivered&limit=10");
});

test("each resource hits the spec path", async () => {
  const cases = [
    [(c) => c.trackings.get("trk 1"), "GET", "/v1/trackings/trk%201"],
    [(c) => c.trackings.update("trk_1", { custom_id: "o1" }), "PUT", "/v1/trackings/trk_1"],
    [(c) => c.trackings.delete("trk_1"), "DELETE", "/v1/trackings/trk_1"],
    [(c) => c.trackings.retrack("trk_1"), "POST", "/v1/trackings/trk_1/retrack"],
    [(c) => c.carriers.list(), "GET", "/v1/carriers"],
    [(c) => c.carriers.get("ups"), "GET", "/v1/carriers/ups"],
    [(c) => c.carriers.detect("1Z999"), "GET", "/v1/carriers/detect?number=1Z999"],
    [(c) => c.carriers.search({ q: "dhl" }), "GET", "/v1/carriers/catalog?q=dhl"],
    [(c) => c.carriers.validationStatus(), "GET", "/v1/carriers/status"],
    [(c) => c.webhooks.create({ url: "https://x.test" }), "POST", "/v1/webhooks"],
    [(c) => c.webhooks.list(), "GET", "/v1/webhooks"],
    [(c) => c.webhooks.delete("wh_1"), "DELETE", "/v1/webhooks/wh_1"],
    [(c) => c.webhooks.update("wh_1", { enabled: false }), "PATCH", "/v1/webhooks/wh_1"],
    [(c) => c.webhooks.rotateSecret("wh_1"), "POST", "/v1/webhooks/wh_1/rotate-secret"],
    [(c) => c.carriers.resolve("USPS Priority"), "GET", "/v1/carriers/resolve?name=USPS+Priority"],
    [(c) => c.health(), "GET", "/v1/health"],
    [(c) => c.webhooks.test("wh_1"), "POST", "/v1/webhooks/wh_1/test"],
    [(c) => c.webhookDeliveries.list({ limit: 5 }), "GET", "/v1/webhook-deliveries?limit=5"],
    [(c) => c.apiKeys.create({ name: "ci", mode: "test" }), "POST", "/v1/account/api-keys"],
    [(c) => c.apiKeys.list(), "GET", "/v1/account/api-keys"],
    [(c) => c.apiKeys.revoke("key_1"), "DELETE", "/v1/account/api-keys/key_1"],
    [(c) => c.usage.get(), "GET", "/v1/account/usage"],
  ];
  for (const [call, method, path] of cases) {
    const { fetch, client } = make([{ body: {} }]);
    await call(client);
    assert.equal(fetch.calls[0].method, method, path);
    assert.equal(fetch.calls[0].url.pathname + fetch.calls[0].url.search, path);
  }
});

test("empty 200 body resolves to null", async () => {
  const { client } = make([{ status: 200 }]);
  assert.equal(await client.webhooks.delete("wh_1"), null);
});

test("iterate walks every page", async () => {
  const page = (ids, offset) => ({
    body: { data: ids.map((id) => ({ id })), pagination: { limit: 2, offset, total: 5 } },
  });
  const { fetch, client } = make([page(["a", "b"], 0), page(["c", "d"], 2), page(["e"], 4)]);
  const ids = [];
  for await (const t of client.trackings.iterate({ limit: 2, status: "delivered" })) ids.push(t.id);
  assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].url.searchParams.get("offset"), "4");
  assert.equal(fetch.calls[2].url.searchParams.get("status"), "delivered");
});

test("errors map to typed classes with status, code and request id", async () => {
  const err = (status, code) => ({
    status,
    body: { error: { code, message: `m${status}`, request_id: "req_1" } },
  });
  const cases = [
    [401, AuthenticationError],
    [404, NotFoundError],
    [400, ValidationError],
    [422, ValidationError],
    [402, QuotaExceededError],
    [409, ConflictError],
  ];
  for (const [status, Cls] of cases) {
    const { client } = make([err(status, "c")]);
    await assert.rejects(client.trackings.get("x"), (e) => {
      assert.ok(e instanceof Cls && e instanceof TrackifiedError);
      assert.equal(e.status, status);
      assert.equal(e.code, "c");
      assert.equal(e.message, `m${status}`);
      assert.equal(e.requestId, "req_1");
      assert.equal(e.request_id, "req_1");
      return true;
    });
  }
});

test("does not retry other 4xx", async () => {
  const { fetch, client } = make([{ status: 409, body: { error: { code: "idempotency_in_progress" } } }]);
  await assert.rejects(
    client.trackings.create({ tracking_number: "1" }),
    (e) => e instanceof ConflictError && e.code === "idempotency_in_progress",
  );
  assert.equal(fetch.calls.length, 1);
});

test("retries 429 honouring retry-after, then raises RateLimitError", async () => {
  const rl = { status: 429, headers: { "retry-after": "0" }, body: { error: { code: "rate_limited" } } };
  const { fetch, client } = make([rl, rl, rl]);
  await assert.rejects(client.usage.get(), (e) => e instanceof RateLimitError && e.retryAfter === 0);
  assert.equal(fetch.calls.length, 3); // 1 + maxRetries(2)
});

test("retries 5xx and 408, raises APIError after maxRetries", async () => {
  const { fetch, client } = make(
    [
      { status: 408, body: {} },
      { status: 502, body: {} },
    ],
    { maxRetries: 1 },
  );
  await assert.rejects(client.usage.get(), APIError);
  assert.equal(fetch.calls.length, 2);
});

test("retries network errors, then raises ConnectionError", async () => {
  const { fetch, client } = make([new TypeError("fetch failed"), { body: { plan: "free" } }]);
  assert.equal((await client.usage.get()).plan, "free");
  assert.equal(fetch.calls.length, 2);

  const m = make([new TypeError("fetch failed")], { maxRetries: 0 });
  await assert.rejects(m.client.usage.get(), (e) => e instanceof ConnectionError && e.code === "connection");
});

test("times out", async () => {
  const fetch = (_url, init) =>
    new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const client = new Trackified({ apiKey: "k", fetch, timeout: 20, maxRetries: 0 });
  await assert.rejects(
    client.usage.get(),
    (e) => e instanceof ConnectionError && e.code === "timeout" && /timed out/.test(e.message),
  );
});

test("base URL from option or env", async () => {
  const { fetch, client } = make([{ body: {} }], { baseURL: "http://localhost:8080/" });
  await client.usage.get();
  assert.equal(fetch.calls[0].url.href, "http://localhost:8080/v1/account/usage");
});

test("base URL accepts the host with or without /v1, never /v1/v1", async () => {
  for (const baseURL of [
    "https://api.trackified.net",
    "https://api.trackified.net/",
    "https://api.trackified.net/v1",
    "https://api.trackified.net/v1/",
  ]) {
    const { fetch, client } = make([{ body: {} }], { baseURL });
    assert.equal(client.baseURL, "https://api.trackified.net");
    await client.usage.get();
    assert.equal(fetch.calls[0].url.href, "https://api.trackified.net/v1/account/usage", baseURL);
  }
});

test("carriers.resolve returns the match or null", async () => {
  const hit = { carrier: "usps", name: "USPS", confidence: 0.97, matched: "alias" };
  const { client } = make([{ body: hit }, { body: { carrier: null, confidence: 0 } }]);
  assert.deepEqual(await client.carriers.resolve("USPS Priority Mail"), hit);
  assert.equal(await client.carriers.resolve("nope"), null);
});

test("webhooks.update and rotateSecret send snake_case bodies; rotate is not retried", async () => {
  const { fetch, client } = make([{ body: {} }, { status: 503, body: {} }]);
  await client.webhooks.update("wh_1", { url: "https://x.test", eventTypes: ["tracking.delivered"] });
  assert.deepEqual(JSON.parse(fetch.calls[0].body), {
    url: "https://x.test",
    event_types: ["tracking.delivered"],
  });
  await assert.rejects(client.webhooks.rotateSecret("wh_1", { expiresInHours: 0 }), APIError);
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { expires_in_hours: 0 });
  assert.equal(fetch.calls.length, 2);
});

test("hooks fire once per attempt with request details; throwing hooks are ignored", async () => {
  const seen = [];
  const { client } = make(
    [
      { status: 500, body: { error: { code: "boom" } }, headers: { "x-request-id": "req_a" } },
      new TypeError("fetch failed"),
      { status: 201, body: tracking, headers: { "x-request-id": "req_c", "idempotent-replayed": "true" } },
    ],
    {
      maxRetries: 2,
      onRequest: (i) => {
        seen.push(["req", i]);
        throw new Error("hook bug");
      },
      onResponse: (i) => {
        seen.push(["res", i]);
        throw new Error("hook bug");
      },
    },
  );
  const t = await client.trackings.create({ tracking_number: "1Z" }, { idempotencyKey: "k1" });
  assert.equal(t.id, "trk_1");
  assert.deepEqual(
    seen.map(([k, i]) => [k, i.attempt]),
    [
      ["req", 0],
      ["res", 0],
      ["req", 1],
      ["res", 1],
      ["req", 2],
      ["res", 2],
    ],
  );
  const [r0, r1, r2] = seen.filter(([k]) => k === "res").map(([, i]) => i);
  assert.equal(seen[0][1].method, "POST");
  assert.equal(seen[0][1].url, "https://api.trackified.net/v1/trackings");
  assert.equal(seen[0][1].idempotencyKey, "k1");
  assert.equal(r0.status, 500);
  assert.equal(r0.requestId, "req_a");
  assert.ok(r0.error instanceof APIError && r0.error.code === "boom");
  assert.equal(r1.status, undefined);
  assert.ok(r1.error instanceof ConnectionError && r1.error.code === "connection");
  assert.equal(r2.status, 201);
  assert.equal(r2.requestId, "req_c");
  assert.equal(r2.idempotentReplayed, true);
  assert.equal(r2.error, undefined);
  assert.ok(r2.durationMs >= 0);
});
