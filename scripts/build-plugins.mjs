import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const metadata = {
  name: "jottacloud",
  version: pkg.version,
  description:
    "Browse and read your Jottacloud files with scoped access and source references.",
  author: { name: "Henrik Øgård" },
  repository: "https://github.com/henrikogaard/jottacloud-mcp",
  license: "MIT",
};
for (const host of ["claude", "openai"]) {
  const out = resolve(root, "artifacts/plugins", host);
  await mkdir(resolve(out, "server"), { recursive: true });
  await build({
    entryPoints: [resolve(root, "src/index.ts")],
    outfile: resolve(out, "server/index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: {
      js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);",
    },
  });
  await cp(resolve(root, "ui"), resolve(out, "ui"), { recursive: true });
  await cp(resolve(root, "skills"), resolve(out, "skills"), {
    recursive: true,
  });
  await cp(resolve(root, "LICENSE"), resolve(out, "LICENSE"));
  const write = (file, data) =>
    writeFile(resolve(out, file), JSON.stringify(data, null, 2) + "\n");
  if (host === "claude") {
    await mkdir(resolve(out, ".claude-plugin"), { recursive: true });
    await write(".claude-plugin/plugin.json", metadata);
    await write(".mcp.json", {
      mcpServers: {
        jottacloud: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/server/index.mjs"],
          env: { JOTTACLOUD_READ_ONLY: "1" },
        },
      },
    });
  } else {
    await write("plugin.json", {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...metadata,
    });
    await write("mcp.json", {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        jottacloud: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server/index.mjs"],
          env: { JOTTACLOUD_READ_ONLY: "1" },
        },
      },
    });
  }
}
console.log(
  "Built standalone local Claude Code and OpenAI plugin packages in artifacts/plugins. Public ChatGPT submission uses the deployed /mcp endpoint.",
);
