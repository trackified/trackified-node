import assert from "node:assert/strict";
import { test } from "node:test";
import { SignatureVerificationError, Trackified } from "../dist/esm/index.js";

// Shared test vector every Trackified SDK must pass.
const secret = "whsec_trackified_test_vector";
const body = '{"id":"evt_test","type":"tracking.updated","data":{"id":"trk_123"}}';
const t = 1792560000;
const sig = "19752dd2fca1872cc8aa6cc36c412fce3bbfa120480580bdb1ad9d7957dfc9f4";
const header = `t=${t},v1=${sig}`;
const { verify, constructEvent } = Trackified.webhooks;

test("accepts the test vector (string and bytes)", async () => {
  assert.equal(await verify(body, header, secret, { now: t }), true);
  assert.equal(await verify(new TextEncoder().encode(body), header, secret, { now: t }), true);
  assert.equal(await verify(Buffer.from(body), header, secret, { now: t + 299 }), true);
});

test("rejects a flipped hex digit", async () => {
  const flipped = sig.slice(0, -1) + (sig.at(-1) === "4" ? "5" : "4");
  assert.equal(await verify(body, `t=${t},v1=${flipped}`, secret, { now: t }), false);
});

test("rejects a different body or secret", async () => {
  assert.equal(await verify(body.replace("trk_123", "trk_124"), header, secret, { now: t }), false);
  assert.equal(await verify(body, header, "whsec_other", { now: t }), false);
});

test("rejects t outside tolerance; tolerance is configurable", async () => {
  assert.equal(await verify(body, header, secret, { now: t + 301 }), false);
  assert.equal(await verify(body, header, secret, { now: t - 301 }), false);
  assert.equal(await verify(body, header, secret, { now: t + 1000, tolerance: 1000 }), true);
  assert.equal(await verify(body, header, secret), false); // real clock: long past
});

test("rejects malformed headers", async () => {
  for (const h of [
    "",
    null,
    undefined,
    "garbage",
    `t=${t}`,
    `v1=${sig}`,
    `t=abc,v1=${sig}`,
    `t=${t},v1=zz`,
    `t=${t},v1=${sig}00`,
  ]) {
    assert.equal(await verify(body, h, secret, { now: t }), false, String(h));
  }
});

test("accepts any matching v1 among several", async () => {
  assert.equal(await verify(body, `t=${t},v1=${"0".repeat(64)},v1=${sig}`, secret, { now: t }), true);
});

test("constructEvent returns the event or throws", async () => {
  const evt = await constructEvent(body, header, secret, { now: t });
  assert.equal(evt.type, "tracking.updated");
  assert.equal(evt.data.id, "trk_123");
  await assert.rejects(constructEvent(body, header, secret, { now: t + 301 }), SignatureVerificationError);
  await assert.rejects(constructEvent(body, "bad", secret, { now: t }), SignatureVerificationError);
});

test("instance helpers match the static ones", async () => {
  const client = new Trackified({ apiKey: "k", fetch: async () => new Response() });
  assert.equal(await client.webhooks.verify(body, header, secret, { now: t }), true);
});
