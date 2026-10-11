import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { decodeLoginToken } from "../auth/login-token.js";
import { TokenStore, type StoredTokens } from "../auth/token-store.js";
import { encodeJfsPath, mapAgentPath, TRASH_ROOT, type JfsMapping } from "./paths.js";
import {
  parseJfsXml,
  parseListstreamXml,
  parseMountPoints,
  withShareUrls,
  type JfsEntry,
  type JfsNode,
} from "./xml.js";

const JFS_BASE = "https://jfs.jottacloud.com/jfs/";
const API_BASE = "https://api.jottacloud.com/";
const DEFAULT_TOKEN_URL =
  "https://id.jottacloud.com/auth/realms/jottacloud/protocol/openid-connect/token";
const CLIENT_ID = "jottacli";

export class JottaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JottaError";
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

type AllocateResponse = {
  name?: string;
  path?: string;
  state?: string;
  upload_id?: string;
  upload_url?: string;
  bytes?: number;
  resume_pos?: number;
};

type CustomerInfo = {
  username: string;
  email?: string;
};

export class JottaClient {
  private refreshInFlight?: Promise<void>;
  private tokens?: StoredTokens;
  private username?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store = new TokenStore(config.tokenStorePath),
  ) {}

  async loginWithPersonalToken(loginTokenRaw: string): Promise<void> {
    const login = decodeLoginToken(loginTokenRaw);
    let tokenUrl = DEFAULT_TOKEN_URL;
    try {
      const wellKnown = await fetch(login.well_known_link);
      if (wellKnown.ok) {
        const body = (await wellKnown.json()) as { token_endpoint?: string };
        if (body.token_endpoint) tokenUrl = body.token_endpoint;
      }
    } catch {
      // fall back to default token URL
    }

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "password",
      username: login.username,
      password: login.auth_token,
      scope: "openid offline_access",
    });
    const token = await postToken(tokenUrl, body);
    const username = await this.resolveUsername(token.access_token, login.username);
    this.username = username;
    this.tokens = { ...token, username };
    await this.store.write(this.tokens);
  }

  async hasSession(): Promise<boolean> {
    try {
      await this.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async ensureReady(): Promise<void> {
    if (!this.tokens) {
      this.tokens = await this.store.read();
    }
    if (!this.tokens && this.config.loginToken) {
      await this.loginWithPersonalToken(this.config.loginToken);
    }
    if (!this.tokens) {
      throw new Error(
        "Not logged in. Set JOTTACLOUD_LOGIN_TOKEN (from https://www.jottacloud.com/web/secure) or run with a populated token store.",
      );
    }
    if (this.tokens.expires_at - 60_000 < Date.now()) {
      await this.refresh();
    }
    if (!this.username) {
      this.username = this.tokens.username ?? (await this.resolveUsername(this.tokens.access_token));
      if (this.tokens.username !== this.username) {
        this.tokens.username = this.username;
        await this.store.write(this.tokens);
      }
    }
  }

  getUsername(): string {
    if (!this.username) throw new Error("Client is not ready");
    return this.username;
  }

  map(path: string, extraRoots: string[] = []): JfsMapping {
    const roots = extraRoots.length === 0 ? this.config.roots : [...this.config.roots, ...extraRoots];
    return mapAgentPath(path, roots, this.getUsername(), this.config.device);
  }

  extraRootsFor(path: string): string[] {
    return path === TRASH_ROOT || path.startsWith(`${TRASH_ROOT}/`) ? [TRASH_ROOT] : [];
  }

  async getNode(path: string, extraRoots: string[] = []): Promise<JfsNode> {
    await this.ensureReady();
    const mapping = this.map(path, extraRoots);
    const xml = await this.jfs("GET", mapping.jfsRelative);
    return withShareUrls(parseJfsXml(xml), this.getUsername());
  }

  async listMounts(): Promise<string[]> {
    await this.ensureReady();
    const xml = await this.jfs("GET", `${this.getUsername()}/${this.config.device}`);
    return parseMountPoints(xml);
  }

  async liststream(path: string, extraRoots: string[] = []): Promise<JfsEntry[]> {
    await this.ensureReady();
    const mapping = this.map(path, extraRoots);
    const xml = await this.jfs("GET", `${mapping.jfsRelative}?mode=liststream`);
    if (xml.length > this.config.limits.searchListstreamMaxBytes) {
      throw new JottaError(
        `liststream response too large (${xml.length} bytes); narrow the search path`,
      );
    }
    return parseListstreamXml(xml);
  }

  async readBytes(
    path: string,
    range?: { start: number; end: number },
    extraRoots: string[] = [],
  ): Promise<{ bytes: Buffer; mime?: string }> {
    await this.ensureReady();
    const mapping = this.map(path, extraRoots);
    const headers: Record<string, string> = {};
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end}`;
    }
    const res = await this.jfsResponse("GET", `${mapping.jfsRelative}?mode=bin`, { headers });
    const mime = res.headers.get("content-type") ?? undefined;
    if (range && range.start > 0 && res.status === 200) {
      await res.body?.cancel();
      throw new JottaError("Server ignored the byte range; narrow the read to the file head.");
    }
    const cap = range ? Math.min(range.end - range.start + 1, this.config.limits.readMaxBytes) : this.config.limits.readMaxBytes;
    const bytes = await readBoundedResponse(res, cap, false);
    return { bytes, mime };
  }

  async mkdir(path: string): Promise<JfsNode> {
    await this.ensureReady();
    const mapping = this.map(path);
    const xml = await this.jfs("POST", `${mapping.jfsRelative}?mkDir=true`);
    return parseJfsXml(xml);
  }

  async mkdirParents(path: string): Promise<void> {
    const mapping = this.map(path);
    const segs = [mapping.mount, ...mapping.restSegments];
    let current = "";
    for (const seg of segs) {
      current += `/${seg}`;
      try {
        await this.mkdir(current);
      } catch {
        // existing folders are fine
      }
    }
  }

  async softDelete(path: string, kind: "file" | "folder", extraRoots: string[] = []): Promise<void> {
    await this.ensureReady();
    const mapping = this.map(path, extraRoots);
    const q = kind === "folder" ? "dlDir=true" : "dl=true";
    await this.jfs("POST", `${mapping.jfsRelative}?${q}`);
  }

  async move(src: string, dest: string, extraSrcRoots: string[] = []): Promise<void> {
    await this.ensureReady();
    const from = this.map(src, extraSrcRoots);
    const to = this.map(dest);
    const srcNode = await this.getNode(src, extraSrcRoots);
    const param = srcNode.kind === "folder" ? "mvDir" : "mv";
    const srcPath = srcNode.kind === "folder" ? `${from.jfsRelative}/` : from.jfsRelative;
    await this.jfs("POST", `${srcPath}?${param}=${encodeURIComponent(to.moveDest)}`);
  }

  async copy(src: string, dest: string, extraSrcRoots: string[] = []): Promise<void> {
    await this.ensureReady();
    const from = this.map(src, extraSrcRoots);
    const to = this.map(dest);
    const srcNode = await this.getNode(src, extraSrcRoots);
    const param = srcNode.kind === "folder" ? "cpDir" : "cp";
    const srcPath = srcNode.kind === "folder" ? `${from.jfsRelative}/` : from.jfsRelative;
    await this.jfs("POST", `${srcPath}?${param}=${encodeURIComponent(to.moveDest)}`);
  }

  async setShare(path: string, enabled: boolean): Promise<JfsNode> {
    await this.ensureReady();
    const mapping = this.map(path);
    const mode = enabled ? "enableShare" : "disableShare";
    const xml = await this.jfs("GET", `${mapping.jfsRelative}?mode=${mode}`);
    return withShareUrls(parseJfsXml(xml), this.getUsername());
  }

  async writeFile(path: string, bytes: Buffer): Promise<{ state: string; skippedUpload: boolean }> {
    await this.ensureReady();
    const mapping = this.map(path);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const now = new Date().toISOString();
    const allocate = await this.apiJson<AllocateResponse>("POST", "files/v1/allocate", {
      bytes: bytes.length,
      created: now,
      modified: now,
      md5,
      path: mapping.allocatePath,
    });
    if (allocate.state === "COMPLETED") {
      return { state: allocate.state, skippedUpload: true };
    }
    if (!allocate.upload_url) {
      throw new JottaError("Allocate did not return upload_url");
    }
    const resume = allocate.resume_pos ?? 0;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.requireAccessToken()}`,
      "Content-Type": "application/octet-stream",
    };
    const body = resume > 0 ? bytes.subarray(resume) : bytes;
    if (resume > 0) {
      headers.Range = `bytes=${resume}-${bytes.length - 1}`;
    }
    const upload = await fetch(allocate.upload_url, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
    });
    if (!upload.ok) {
      throw new JottaError(`Upload failed: HTTP ${upload.status} ${await upload.text()}`, upload.status);
    }
    return { state: allocate.state ?? "uploaded", skippedUpload: false };
  }

  private requireAccessToken(): string {
    if (!this.tokens) throw new Error("Not authenticated");
    return this.tokens.access_token;
  }

  private async resolveUsername(accessToken: string, fallback?: string): Promise<string> {
    const res = await fetch(`${API_BASE}account/v1/customer`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      if (fallback) return fallback;
      throw new JottaError(`Failed to resolve username: HTTP ${res.status}`, res.status);
    }
    const customer = (await res.json()) as CustomerInfo;
    return customer.username || fallback || "";
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = this.store.withLock(async () => {
      const latest = (await this.store.read()) ?? this.tokens;
      if (!latest) throw new Error("Cannot refresh: no tokens");
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: latest.refresh_token,
      });
      const token = await postToken(DEFAULT_TOKEN_URL, body);
      this.tokens = {
        ...token,
        username: latest.username ?? this.username,
      };
      await this.store.write(this.tokens);
    });
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async apiJson<T>(method: string, path: string, json?: unknown): Promise<T> {
    const res = await this.fetchWithAuth(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: json == null ? undefined : JSON.stringify(json),
    });
    return (await res.json()) as T;
  }

  private async jfs(method: string, relative: string): Promise<string> {
    const res = await this.jfsResponse(method, relative);
    return (await readBoundedResponse(res, this.config.limits.searchListstreamMaxBytes, true)).toString("utf8");
  }

  private async jfsResponse(
    method: string,
    relative: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const encoded = relative.includes("?")
      ? `${encodeJfsPath(relative.slice(0, relative.indexOf("?")))}${relative.slice(relative.indexOf("?"))}`
      : encodeJfsPath(relative);
    return this.fetchWithAuth(`${JFS_BASE}${encoded}`, {
      ...init,
      method,
      headers: {
        Accept: "application/xml",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  private async fetchWithAuth(url: string, init: RequestInit, retry = true): Promise<Response> {
    await this.ensureReady();
    const res = await fetchWithRetry(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.requireAccessToken()}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 401 && retry) {
      await this.refresh();
      return this.fetchWithAuth(url, init, false);
    }
    if (!res.ok) {
      const body = await res.text();
      let detail = body.slice(0, 400);
      try {
        const parsed = parseJfsXml(body);
        detail = JSON.stringify(parsed);
      } catch {
        // keep raw snippet
      }
      throw new JottaError(`Jottacloud HTTP ${res.status}: ${detail}`, res.status);
    }
    return res;
  }
}

async function postToken(url: string, body: URLSearchParams): Promise<StoredTokens> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new JottaError(`Token request failed: HTTP ${res.status} ${await res.text()}`, res.status);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token) {
    throw new JottaError("Token response missing access or refresh token");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (last.status !== 429 && last.status < 500) return last;
    const delay = Math.min(2000, 50 * 2 ** i);
    await new Promise((r) => setTimeout(r, delay));
  }
  return last!;
}

/** Enforce caps while reading, including servers that ignore HTTP Range. */
export async function readBoundedResponse(
  response: Response,
  cap: number,
  rejectOverflow: boolean,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > cap - total && rejectOverflow) {
        throw new Error("Response exceeds the configured byte limit.");
      }
      const chunk = value.subarray(0, cap - total);
      chunks.push(chunk);
      total += chunk.length;
      if (total === cap && !rejectOverflow) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
