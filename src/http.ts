#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { JottaClient } from "./jotta/client.js";
import { PrivateOAuth } from "./auth/private-oauth.js";
import { createHttpApp } from "./http-app.js";
async function main() {
  const config = { ...loadConfig(), readOnly: true };
  const raw = process.env.JOTTACLOUD_PUBLIC_URL;
  if (!raw)
    throw new Error(
      "Set JOTTACLOUD_PUBLIC_URL to the HTTPS origin (or http://localhost for local testing).",
    );
  const issuer = new URL(raw);
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/" ||
    (issuer.protocol !== "https:" &&
      !(
        issuer.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(issuer.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS origin without a path, credentials, query or fragment.",
    );
  const oauth = new PrivateOAuth(
    process.env.JOTTACLOUD_OAUTH_STORE ?? `${config.tokenStorePath}.oauth.json`,
    issuer,
    process.env.JOTTACLOUD_CONNECT_PASSWORD ?? "",
    (process.env.JOTTACLOUD_OAUTH_REDIRECTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    config.roots,
  );
  await oauth.load();
  const client = new JottaClient(config);
  await client.ensureReady();
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createHttpApp(client, config, oauth).listen(port, host, () =>
    console.error(
      `Private Jottacloud MCP listening on ${host}:${port}. Public origin: ${issuer.origin}`,
    ),
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => server.close());
}
main().catch(() => {
  console.error(
    "Unable to start private Jottacloud HTTP service. Check URL, OAuth password/redirects, token store and Jottacloud login.",
  );
  process.exitCode = 1;
});
