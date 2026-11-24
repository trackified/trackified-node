const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Trackified, NotFoundError, verify } = require("../dist/cjs/index.js");

test("CommonJS build loads and verifies", async () => {
  assert.equal(typeof Trackified, "function");
  assert.equal(typeof NotFoundError, "function");
  const h = "t=1792560000,v1=19752dd2fca1872cc8aa6cc36c412fce3bbfa120480580bdb1ad9d7957dfc9f4";
  const b = '{"id":"evt_test","type":"tracking.updated","data":{"id":"trk_123"}}';
  assert.equal(await verify(b, h, "whsec_trackified_test_vector", { now: 1792560000 }), true);
});
