// Optional live smoke test: runs only when TRACKIFIED_API_KEY is set. Never set it in CI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Trackified } from "../dist/esm/index.js";

test("live: create, get, list, delete one tracking", { skip: !process.env.TRACKIFIED_API_KEY }, async () => {
  const client = new Trackified({ baseURL: process.env.TRACKIFIED_API_BASE || undefined });
  const t = await client.trackings.create({ tracking_number: "9434650110837017316201", carrier: "usps" });
  try {
    assert.equal((await client.trackings.get(t.id)).id, t.id);
    const page = await client.trackings.list({ tracking_number: "9434650110837017316201", limit: 5 });
    assert.ok(page.data.some((x) => x.id === t.id));
    const d = await client.carriers.detect("9434650110837017316201");
    assert.ok(d.candidates.length > 0);
    assert.ok((await client.usage.get()).plan);
  } finally {
    const del = await client.trackings.delete(t.id);
    assert.equal(del.deleted, true);
  }
});
