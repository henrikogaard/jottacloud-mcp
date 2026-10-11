import assert from "node:assert/strict";
import { it } from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const host of ["claude", "openai"]) {
  it(`${host} bundle runs outside the repository without credentials or dependencies`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "jotta-plugin-test-"));
    await cp(
      new URL(`../artifacts/plugins/${host}/`, import.meta.url),
      directory,
      { recursive: true },
    );
    const client = new Client({
      name: "plugin-payload-check",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(directory, "server/index.mjs")],
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        JOTTACLOUD_TOKEN_STORE: join(directory, "missing-tokens.json"),
        JOTTACLOUD_ROOTS: "/Sync/Documents",
        JOTTACLOUD_READ_ONLY: "1",
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === "browse_files"));
      assert.ok(
        !tools.some((tool) =>
          ["write_file", "delete", "move", "share"].includes(tool.name),
        ),
      );
      const resource = await client.readResource({
        uri: "ui://jottacloud/browser.html",
      });
      assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert.ok(
        "text" in resource.contents[0]! &&
          resource.contents[0].text.includes("<html"),
      );
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
