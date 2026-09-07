/* Bound the complete transfer, not just the arrival of HTTP headers. */
export async function fetchAsset(url, format = "arrayBuffer", {
  timeoutMs = 30000, fetchImpl = globalThis.fetch
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return await response[format]();
  } finally {
    clearTimeout(timer);
  }
}
