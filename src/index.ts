#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createJottaMcpServer } from "./create-server.js";
import { JottaClient } from "./jotta/client.js";

function log(...args: unknown[]): void {
  console.error(...args);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const client = new JottaClient(config);

  if (argv.includes("--login")) {
    if (!config.loginToken) {
      throw new Error("Set JOTTACLOUD_LOGIN_TOKEN before --login");
    }
    await client.loginWithPersonalToken(config.loginToken);
    log(`Logged in. Tokens saved to ${config.tokenStorePath}`);
    log("You can drop JOTTACLOUD_LOGIN_TOKEN from MCP env after this.");
    return;
  }

  serveStdio(() => createJottaMcpServer(client, config));
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});
