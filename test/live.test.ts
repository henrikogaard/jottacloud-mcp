import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { JottaClient } from "../src/jotta/client.ts";

const enabled = process.env.JOTTACLOUD_LIVE_TEST === "1";

describe("live Jottacloud", { skip: !enabled }, () => {
  it("lists Archive and can liststream-search", async () => {
    const config = loadConfig();
    const client = new JottaClient(config);
    await client.ensureReady();

    const root = await client.getNode(config.roots[0] ?? "/Archive");
    assert.equal(root.kind, "folder");

    const mounts = await client.listMounts();
    assert.ok(mounts.some((m) => m === "/Archive" || m === "/Sync"));

    const stream = await client.liststream(config.roots[0] ?? "/Archive");
    assert.ok(Array.isArray(stream));
  });
});
