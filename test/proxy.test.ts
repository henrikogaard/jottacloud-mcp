import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { useProxyFromEnvironment } from "../src/proxy.js";

test("does nothing when no proxy is named", () => {
  const before = getGlobalDispatcher();
  assert.equal(useProxyFromEnvironment({}), false);
  assert.equal(getGlobalDispatcher(), before);
});

test("sends fetch through the proxy named in HTTPS_PROXY", async () => {
  const before = getGlobalDispatcher();
  const seen: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    seen.push(request.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const address = proxy.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    assert.equal(useProxyFromEnvironment({ HTTPS_PROXY: `http://127.0.0.1:${port}` }), true);
    await assert.rejects(fetch("https://id.jottacloud.com/health"));
    assert.deepEqual(seen, ["id.jottacloud.com:443"]);
  } finally {
    setGlobalDispatcher(before);
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
