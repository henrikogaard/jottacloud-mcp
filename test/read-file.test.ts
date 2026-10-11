import assert from "node:assert/strict";
import { it } from "node:test";
import { looksText } from "../src/read-file.ts";
import { loadConfig } from "../src/config.ts";
import { JottaClient } from "../src/jotta/client.ts";
import { TokenStore } from "../src/auth/token-store.ts";
it("does not decode invalid UTF-8 binary as text", () =>
  assert.equal(
    looksText("application/octet-stream", Buffer.from([0xff, 0xfe, 0xfd])),
    false,
  ));
it("enforces read limit when the server ignores Range", async () => {
  const config = loadConfig();
  const store = new TokenStore("/not-used");
  store.read = async () => ({
    access_token: "test",
    refresh_token: "test",
    expires_at: Date.now() + 3600000,
    username: "test",
  });
  const client = new JottaClient(config, store);
  const prev = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(10000), {
      headers: { "content-type": "application/octet-stream" },
    });
  try {
    const result = await client.readBytes(`${config.roots[0]}/large.bin`, {
      start: 0,
      end: 63,
    });
    assert.equal(result.bytes.length, 64);
  } finally {
    globalThis.fetch = prev;
  }
});
