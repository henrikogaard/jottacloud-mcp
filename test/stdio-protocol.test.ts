import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(repoRoot, "src/index.ts");

type JsonRpc = {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  method?: string;
};

async function rpc(
  child: ReturnType<typeof spawn>,
  message: unknown,
  id: number,
  timeoutMs = 12_000,
): Promise<JsonRpc> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stdout?.off("data", onData);
      reject(new Error(`Timed out waiting for JSON-RPC id=${id}. stderr=${stderr.slice(-2000)}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: JsonRpc;
        try {
          parsed = JSON.parse(trimmed) as JsonRpc;
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  });
}

let stderr = "";

describe("stdio JSON-RPC smoke (MCP Inspector stand-in)", () => {
  it("initialize + tools/list + resources/templates/list", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "jottacloud-mcp-ci-"));
    const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        JOTTACLOUD_TOKEN_STORE: join(storeDir, "tokens.json"),
        JOTTACLOUD_READ_ONLY: "1",
      },
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      const init = await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "jottacloud-mcp-ci", version: "0" },
        },
      }, 1);

      assert.equal(init.error, undefined, init.error?.message);
      assert.equal((init.result?.serverInfo as { name?: string } | undefined)?.name, "jottacloud-mcp");

      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );

      const tools = await rpc(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }, 2);

      assert.equal(tools.error, undefined, tools.error?.message);
      const names = ((tools.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
      for (const required of ["login", "list_roots", "list_directory", "search_files", "read_file", "list_trash"]) {
        assert.ok(names.includes(required), `missing tool ${required}: ${names.join(",")}`);
      }
      assert.ok(!names.includes("write_file"), "read-only mode should omit write tools");

      const templates = await rpc(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/templates/list",
        params: {},
      }, 3);

      assert.equal(templates.error, undefined, templates.error?.message);
      const uris = ((templates.result?.resourceTemplates as { uriTemplate?: string }[] | undefined) ?? []).map(
        (t) => t.uriTemplate,
      );
      assert.ok(
        uris.some((u) => u?.includes("jotta:///")),
        `expected jotta:/// template, got ${uris.join(",")}`,
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
