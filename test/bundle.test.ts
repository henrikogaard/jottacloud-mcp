import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the bundled stdio server starts from an empty folder with no node_modules", async () => {
  execFileSync(process.execPath, ["scripts/build-bundle.mjs"], { stdio: "inherit" });
  const dir = mkdtempSync(join(tmpdir(), "jotta-bundle-"));
  try {
    copyFileSync("dist/stdio.bundle.mjs", join(dir, "stdio.bundle.mjs"));
    const child = spawn(process.execPath, ["stdio.bundle.mjs"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", JOTTACLOUD_TOKEN_STORE: join(dir, "tokens.json") },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const reply = new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolve(String(chunk)));
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      })}\n`,
    );
    try {
      assert.equal(JSON.parse((await reply).split("\n")[0] ?? "").result.serverInfo.name, "jottacloud-mcp");
    } finally {
      child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
