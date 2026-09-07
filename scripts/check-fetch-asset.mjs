import assert from "node:assert/strict";
import { fetchAsset } from "../js/lib/fetch-asset.js";
assert.deepEqual(await fetchAsset("meta", "json", {
  fetchImpl: async () => ({ ok: true, json: async () => ({ ready: true }) })
}), { ready: true });
await assert.rejects(fetchAsset("missing", "json", {
  fetchImpl: async () => ({ ok: false, status: 404 })
}), /404/);
await assert.rejects(fetchAsset("stalled-body", "arrayBuffer", {
  timeoutMs: 5,
  fetchImpl: async (_, { signal }) => ({
    ok: true,
    arrayBuffer: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted body")), { once: true });
    })
  })
}), /aborted body/);
console.log("Asset loading verified: success, HTTP failure, timeout during response body.");
