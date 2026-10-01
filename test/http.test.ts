import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PrivateOAuth } from "../src/auth/private-oauth.ts";
import { createHttpApp } from "../src/http-app.ts";
import { loadConfig } from "../src/config.ts";
import { JottaClient } from "../src/jotta/client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const password = "synthetic-private-service-password-123456";
it("OAuth consent, PKCE, read-only MCP, revocation and persisted tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jotta-oauth-test-"));
  const issuer = new URL("http://127.0.0.1");
  const redirect = "http://127.0.0.1:9999/callback";
  const file = join(directory, "oauth.json");
  const oauth = new PrivateOAuth(file, issuer, password, [redirect], ["/Sync"]);
  await oauth.load();
  const config = { ...loadConfig(), roots: ["/Sync"] };
  const client = new JottaClient(config);
  client.getNode = async (path) =>
    path.endsWith("welcome.md")
      ? {
          kind: "file",
          name: "welcome.md",
          path,
          mime: "text/markdown",
          size: 7,
        }
      : {
          kind: "folder",
          name: "Sync",
          path,
          folders: [],
          files: [
            {
              kind: "file",
              name: "welcome.md",
              path: "/Sync/welcome.md",
              mime: "text/markdown",
              size: 7,
            },
          ],
        };
  client.readBytes = async () => ({
    bytes: Buffer.from("welcome"),
    mime: "text/markdown",
  });
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  issuer.port = String(
    (server.address() as import("node:net").AddressInfo).port,
  );
  const url = issuer.origin;
  server.on("request", createHttpApp(client, config, oauth));
  const post = (path: string, data: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await fetch(url + "/mcp", { method: "POST" })).status, 401);
    const metadata = await (
      await fetch(url + "/.well-known/oauth-protected-resource/mcp")
    ).json();
    assert.equal(metadata.resource, url + "/mcp");
    assert.equal(
      (
        await post("/register", {
          redirect_uris: ["https://evil.example/callback"],
          token_endpoint_auth_method: "none",
        })
      ).status,
      400,
    );
    const registration = await post("/register", {
      redirect_uris: [redirect],
      client_name: "Test host",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "jottacloud.read",
      state: "test-state",
      resource: url + "/mcp",
    });
    const auth = await fetch(url + "/authorize?" + params);
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    const html = await auth.text();
    const request = html.match(/name="request" value="([^"]+)"/)![1];
    const consent = (pass: string, origin = url) =>
      fetch(url + "/connect", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          origin,
        },
        body: new URLSearchParams({
          request,
          password: pass,
          decision: "allow",
        }),
        redirect: "manual",
      });
    assert.equal((await consent(password, "https://evil.example")).status, 400);
    assert.equal((await consent("wrong")).status, 403);
    const allowed = await consent(password);
    assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get("location")!);
    assert.equal(callback.searchParams.get("state"), "test-state");
    const code = callback.searchParams.get("code")!;
    const exchange = (v: string, resource = url + "/mcp") =>
      fetch(url + "/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: registered.client_id,
          grant_type: "authorization_code",
          code,
          code_verifier: v,
          redirect_uri: redirect,
          resource,
        }),
      });
    assert.equal((await exchange("wrong")).status, 400);
    const tokenResponse = await exchange(verifier);
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal((await exchange(verifier)).status, 400);
    const model = new Client({ name: "private-http-test", version: "1" });
    await model.connect(
      new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    const list = await model.listTools();
    assert.ok(list.tools.some((t) => t.name === "browse_files"));
    assert.ok(
      !list.tools.some(
        (t) =>
          t.name === "login" ||
          t.name === "write_file" ||
          t.name === "list_trash",
      ),
    );
    const page = await model.callTool({ name: "browse_files", arguments: {} });
    assert.equal((page.structuredContent as any).path, "/Sync");
    const blocked = await model.callTool({
      name: "browse_files",
      arguments: { path: "/Trash" },
    });
    assert.equal(blocked.isError, true);
    const preview = await model.callTool({
      name: "preview_file",
      arguments: { path: "/Sync/welcome.md" },
    });
    assert.equal("content" in (preview.structuredContent as object), false);
    assert.equal((preview._meta as any).preview.content, "welcome");
    assert.deepEqual(preview.content, []);
    const selection = await model.callTool({
      name: "select_file",
      arguments: { path: "/Sync/welcome.md" },
    });
    assert.ok(
      JSON.stringify(selection.content).includes("untrustedFileContent"),
    );
    const ui = await model.readResource({
      uri: "ui://jottacloud/browser.html",
    });
    assert.ok((ui.contents[0] as any).text.includes("Jottacloud"));
    await model.close();
    const stored = await readFile(file, "utf8");
    assert.ok(!stored.includes(tokens.access_token));
    assert.ok(!stored.includes(tokens.refresh_token));
    assert.ok(!stored.includes(password));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const reload = new PrivateOAuth(
      file,
      issuer,
      password,
      [redirect],
      ["/Sync"],
    );
    await reload.load();
    await reload.verifyAccessToken(tokens.access_token);
    const wider = new PrivateOAuth(
      file,
      issuer,
      password,
      [redirect],
      ["/Sync", "/Archive"],
    );
    await wider.load();
    await assert.rejects(() => wider.verifyAccessToken(tokens.access_token));
    const rotated = await oauth.exchangeRefreshToken(
      registered,
      tokens.refresh_token,
    );
    await assert.rejects(() =>
      oauth.exchangeRefreshToken(registered, tokens.refresh_token),
    );
    await assert.rejects(() => oauth.verifyAccessToken(rotated.access_token));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }
});
