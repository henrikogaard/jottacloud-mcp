import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const random = () => randomBytes(32).toString("base64url");
const digest = (s: string) =>
  createHash("sha256").update(s).digest("base64url");
const now = () => Math.floor(Date.now() / 1000);
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Token = {
  hash: string;
  client: string;
  family: string;
  kind: "access" | "refresh";
  expires: number;
  active: boolean;
  policy: string;
};
type State = { clients: OAuthClientInformationFull[]; tokens: Token[] };
type Grant = {
  client: string;
  params: AuthorizationParams;
  expires: number;
  csrf: string;
};
/** Private, single-account OAuth gateway. Never use this provider for shared account access. */
export class PrivateOAuth implements OAuthServerProvider {
  // Validate S256 here before consuming the code; the SDK then forwards the verifier.
  readonly skipLocalPkceValidation = true;
  private state: State = { clients: [], tokens: [] };
  private pending = new Map<string, Grant>();
  private codes = new Map<string, Grant>();
  private serial: Promise<unknown> = Promise.resolve();
  readonly clientsStore = {
    getClient: async (id: string) =>
      this.state.clients.find((c) => c.client_id === id),
    registerClient: async (
      input: Omit<
        OAuthClientInformationFull,
        "client_id" | "client_id_issued_at"
      >,
    ) => {
      if (
        !input.redirect_uris.length ||
        input.redirect_uris.some((uri) => !this.redirects.includes(uri))
      )
        throw new InvalidClientMetadataError(
          "Redirect URI is not in the owner-configured allowlist.",
        );
      const client = {
        ...input,
        client_id: random(),
        client_id_issued_at: now(),
      };
      await this.change((s) => {
        if (s.clients.length >= 100)
          throw new InvalidClientMetadataError("Client limit reached.");
        s.clients.push(client);
      });
      return client;
    },
  };
  constructor(
    private readonly file: string,
    readonly issuer: URL,
    private readonly password: string,
    private readonly redirects: string[],
    private readonly roots: string[],
  ) {
    if (password.length < 32)
      throw new Error(
        "JOTTACLOUD_CONNECT_PASSWORD must have at least 32 characters.",
      );
    if (!redirects.length)
      throw new Error(
        "Configure the exact OAuth redirect URI(s) shown by ChatGPT.",
      );
    for (const uri of redirects) {
      const u = new URL(uri);
      if (
        u.username ||
        u.password ||
        u.hash ||
        (u.protocol !== "https:" &&
          !["localhost", "127.0.0.1"].includes(u.hostname))
      )
        throw new Error("Invalid OAuth redirect URI.");
    }
  }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (!Array.isArray(state.clients) || !Array.isArray(state.tokens))
        throw new Error("Invalid OAuth store.");
      this.state = state;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private change<T>(fn: (s: State) => T): Promise<T> {
    const result = this.serial.then(async () => {
      const next = structuredClone(this.state);
      next.tokens = next.tokens.filter((t) => t.expires > now());
      const out = fn(next);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, this.file);
      this.state = next;
      return out;
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  private resource(resource?: URL) {
    if (resource && resource.href !== new URL("/mcp", this.issuer).href)
      throw new InvalidTargetError("Wrong resource.");
  }
  private scopes(scopes?: string[]) {
    if (scopes?.some((s) => s !== "jottacloud.read"))
      throw new InvalidScopeError("Only jottacloud.read is supported.");
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    this.resource(params.resource);
    this.scopes(params.scopes);
    if (!this.redirects.includes(params.redirectUri))
      throw new InvalidGrantError("Redirect URI is no longer allowed.");
    for (const [id, g] of this.pending)
      if (g.expires <= now()) this.pending.delete(id);
    for (const [id, g] of this.codes)
      if (g.expires <= now()) this.codes.delete(id);
    if (this.pending.size >= 100)
      throw new InvalidGrantError("Too many pending connections.");
    const id = random(),
      csrf = random();
    this.pending.set(id, {
      client: client.client_id,
      params,
      expires: now() + 300,
      csrf,
    });
    res.cookie("jottacloud-consent", csrf, {
      httpOnly: true,
      secure: this.issuer.protocol === "https:",
      sameSite: "lax",
      path: "/connect",
      maxAge: 300000,
    });
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Jottacloud</title><body><main><h1>Connect your Jottacloud files</h1><p>This is a private connection to the service owner's account.</p><p>Allow ${escape(client.client_name ?? "this client")} to read files in:</p><ul>${this.roots.map((r) => `<li>${escape(r)}</li>`).join("")}</ul><p>No upload, move, deletion or sharing is allowed.</p><form method="post" action="/connect"><input type="hidden" name="request" value="${id}"><label>Connection password <input name="password" type="password" autocomplete="current-password" required maxlength="512"></label><p>This is the service connection password, not your Jottacloud password or login token.</p><button name="decision" value="allow">Allow read access</button><button name="decision" value="deny" formnovalidate>Cancel</button></form></main></body></html>`,
      );
  }
  async consent(req: Request, res: Response) {
    const id = typeof req.body?.request === "string" ? req.body.request : "";
    const grant = this.pending.get(id);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("jottacloud-consent="))
      ?.slice("jottacloud-consent=".length);
    if (
      !grant ||
      grant.expires <= now() ||
      !cookie ||
      !equal(cookie, grant.csrf) ||
      req.headers.origin !== this.issuer.origin
    ) {
      res
        .status(400)
        .send("Connection request expired or invalid. Start again in ChatGPT.");
      return;
    }
    if (
      req.body.decision !== "deny" &&
      (typeof req.body.password !== "string" ||
        !equal(req.body.password, this.password))
    ) {
      res
        .status(403)
        .send(
          "Connection denied. Start again and use the service connection password.",
        );
      return;
    }
    this.pending.delete(id);
    res.clearCookie("jottacloud-consent", { path: "/connect" });
    const dest = new URL(grant.params.redirectUri);
    if (req.body.decision === "deny")
      dest.searchParams.set("error", "access_denied");
    else {
      const code = random();
      this.codes.set(digest(code), grant);
      dest.searchParams.set("code", code);
    }
    if (grant.params.state) dest.searchParams.set("state", grant.params.state);
    res.redirect(303, dest.href);
  }
  private code(client: OAuthClientInformationFull, code: string) {
    const grant = this.codes.get(digest(code));
    if (!grant || grant.client !== client.client_id || grant.expires <= now())
      throw new InvalidGrantError("Invalid authorization code.");
    return grant;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return this.code(client, code).params.codeChallenge;
  }
  private policy() {
    return digest(
      JSON.stringify({ issuer: this.issuer.href, roots: this.roots }),
    );
  }
  private issue(s: State, client: string, family = random()): OAuthTokens {
    const access = random(),
      refresh = random();
    s.tokens.push(
      {
        hash: digest(access),
        client,
        family,
        kind: "access",
        expires: now() + 3600,
        active: true,
        policy: this.policy(),
      },
      {
        hash: digest(refresh),
        client,
        family,
        kind: "refresh",
        expires: now() + 30 * 86400,
        active: true,
        policy: this.policy(),
      },
    );
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "jottacloud.read",
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.resource(resource);
    const grant = this.code(client, code);
    if (
      !verifier ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !equal(digest(verifier), grant.params.codeChallenge) ||
      redirectUri !== grant.params.redirectUri
    )
      throw new InvalidGrantError("Invalid PKCE verifier or redirect URI.");
    this.codes.delete(digest(code));
    return this.change((s) => this.issue(s, client.client_id));
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.resource(resource);
    this.scopes(scopes);
    const result = await this.change((s) => {
      const token = s.tokens.find(
        (t) =>
          t.hash === digest(refresh) &&
          t.kind === "refresh" &&
          t.client === client.client_id,
      );
      if (!token) return undefined;
      if (!token.active || token.policy !== this.policy()) {
        s.tokens = s.tokens.filter((t) => t.family !== token.family);
        return undefined;
      }
      token.active = false;
      return this.issue(s, token.client, token.family);
    });
    if (!result) throw new InvalidGrantError("Invalid refresh token.");
    return result;
  }
  async verifyAccessToken(raw: string): Promise<AuthInfo> {
    await this.serial;
    const token = this.state.tokens.find(
      (t) =>
        t.hash === digest(raw) &&
        t.kind === "access" &&
        t.active &&
        t.expires > now() &&
        t.policy === this.policy(),
    );
    if (!token) throw new InvalidTokenError("Invalid access token.");
    return {
      token: raw,
      clientId: token.client,
      scopes: ["jottacloud.read"],
      expiresAt: token.expires,
      resource: new URL("/mcp", this.issuer),
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    await this.change((s) => {
      const t = s.tokens.find(
        (t) =>
          t.hash === digest(request.token) && t.client === client.client_id,
      );
      if (t) s.tokens = s.tokens.filter((x) => x.family !== t.family);
    });
  }
}
