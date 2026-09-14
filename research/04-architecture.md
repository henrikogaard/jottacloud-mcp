# Jottacloud MCP — Architecture Recommendation

## Verdict

Build **jottacloud-mcp v1** as a **TypeScript stdio MCP server** (`@modelcontextprotocol/server` SDK v2) that authenticates via the **jottacli personal-login-token → OIDC password grant** flow, talks to **JFS (XML)** for list/read/mkdir/delete/move and **files/v1 (JSON)** for uploads, and exposes a **small annotated tool set** (~9 tools). Ship as an `npx`-able package. Cursor/Claude/Codex spawn it locally; **Grok Bot** runs the same `npx` command on its cloud computer. No public HTTP MCP in v1.

## Auth approach

**Decision:** Personal login token + `client_id=jottacli`, same path as official `jotta-cli` and rclone.

1. User generates a one-shot token at [https://www.jottacloud.com/web/secure](https://www.jottacloud.com/web/secure).
2. Server (or a one-time `login` CLI helper) base64url-decodes the token JSON (`username`, `auth_token`, `well_known_link`), then `POST`s to the OIDC token endpoint with:
   - `grant_type=password`
   - `client_id=jottacli`
   - `username` / `password` = token fields
   - `scope=openid offline_access`
3. Persist **access + latest refresh** tokens under a user-local path (e.g. `~/.config/jottacloud-mcp/tokens.json`, mode `0600`). Prefer env-only bootstrap: `JOTTACLOUD_LOGIN_TOKEN` for first exchange; thereafter refresh from disk.
4. All API calls use `Authorization: Bearer <access_token>`. Refresh ~hourly; on each refresh **atomically replace** the stored refresh token (rotation + reuse detection will invalidate the whole family if two processes race).
5. Resolve internal username once via `GET https://api.jottacloud.com/account/v1/customer` and cache it for JFS paths.

**Out of scope for v1:** browser authorization_code, legacy username/password + OTP headers, sharing one token store across concurrent MCP instances without a lock.

**Env contract:**

| Variable | Role |
|---|---|
| `JOTTACLOUD_LOGIN_TOKEN` | One-shot personal login token (bootstrap) |
| `JOTTACLOUD_TOKEN_STORE` | Optional override path for persisted OAuth tokens |
| `JOTTACLOUD_ROOTS` | Comma-separated allowed path prefixes (default `/Archive`) |
| `JOTTACLOUD_READ_ONLY` | `1` → omit/no-op write tools |
| `JOTTACLOUD_DEVICE` / `JOTTACLOUD_MOUNT` | Defaults `Jotta` / `Archive` |

Do **not** accept tokens as tool arguments. Do **not** log tokens or Authorization headers.

## MVP tool/resource surface

**Path model:** Agent-facing paths are mount-relative absolute paths, e.g. `/Archive/docs/note.md`. Internally map to `https://jfs.jottacloud.com/jfs/{username}/Jotta/Archive/...`.

**Tools (v1) — prefer tools over resources for agent control:**

| Name | Purpose | readOnly / destructive | Maps to Jotta API |
|---|---|---|---|
| `list_roots` | Show allowed mounts / configured roots | readOnly | Config + optional `GET jfs/{user}` devices |
| `list_directory` | List folder entries (name, type, size, modified, path); `limit` + `cursor` | readOnly | `GET jfs/.../{path}` (XML folder) |
| `get_file_info` | Metadata only | readOnly | `GET jfs/.../{path}` (XML file/folder) |
| `search_files` | Name/substring filter under a root (client-side over list/`liststream`) | readOnly | `GET jfs/...` and/or `?mode=liststream` + local filter |
| `read_file` | Read text (capped) or small binary as base64; `head`/`tail`/`max_bytes` | readOnly | `GET jfs/.../{path}?mode=bin` |
| `write_file` | Create/overwrite file from text or base64; size cap; recommend confirm on overwrite | mutating | `POST api…/files/v1/allocate` + `POST upload_url` (octet-stream); skip body if allocate `state=COMPLETED` |
| `create_directory` | Idempotent mkdir (parents as needed) | mutating | `POST jfs/.../{path}?mkDir=true` |
| `move_file` | Move/rename file or directory; fail if dest exists unless `overwrite` | mutating | `POST …?mv=` / `?mvDir=` |
| `delete_file` | Soft-delete to trash; **require `confirm=true`** | destructive | `POST …?dl=true` / `?dlDir=true` (not hard `rm`/`rmDir` in v1) |

**Annotations (all tools):** set `openWorldHint: true`. Mark read tools `readOnlyHint: true`; `delete_file` `destructiveHint: true`; `create_directory` `idempotentHint: true` when possible.

**Resources (optional enrichment, not required for core value):**

| Item | Decision |
|---|---|
| Scheme | `jotta:///{urlencoded-path}` |
| Templates | Advertise template; do **not** enumerate the whole account in `resources/list` |
| `resources/read` | Same bytes/text path as `read_file` (caps apply) |
| Prompts | Skip in v1 |

**Explicitly deferred:** `create_share_link`, hard-delete / `purge_trash`, copy, thumbnail, download-to-local sandbox, Streamable HTTP / marketplace OAuth.

## Stack & packaging

| Choice | Decision |
|---|---|
| Language | **TypeScript** (Node 20+) |
| SDK | **Required:** Official `@modelcontextprotocol/server` (SDK **v2**). Prefer negotiating up to protocol revision **2026-07-28** where hosts support it. |
| Target hosts | Cursor, Claude Desktop/Code, Codex, **Grok Bot** (stdio via `npx`; Bot runs the process on its cloud VM). grok.com custom connectors are out of scope. |
| Transport | **stdio only** |
| HTTP client | `fetch` or undici; XML parse with a small dependency (e.g. `fast-xml-parser`) |
| Auth reference | Mirror rclone / mifi/jotta personal-token exchange; keep Jotta client in a thin internal module |
| Package | npm package with `bin` entry, e.g. `@jottacloud/mcp` or `jottacloud-mcp` → `node dist/index.js` |
| Install | `npx -y <package>` for hosts; optional Docker later |
| Tests | Unit tests for path sandbox + XML/JSON mapping; integration tests against live API behind a flag |

**Why not Python:** Official filesystem MCP and strongest packaging story for Claude/Cursor are TS/stdio/`npx`. Existing TS client patterns (mifi/jotta) align. No strong Python-only library dependency.

## Client config

Full per-client locations, remote variants, and approval notes: **[research/03-client-integration.md](./03-client-integration.md)**. Prefer **stdio + env credentials** for personal use; do not commit secrets.

**Canonical stdio example** (Claude Desktop / Cursor-shaped JSON; adapt Codex TOML per doc 03):

```json
{
  "mcpServers": {
    "jottacloud": {
      "command": "npx",
      "args": ["-y", "jottacloud-mcp"],
      "env": {
        "JOTTACLOUD_LOGIN_TOKEN": "your-personal-login-token",
        "JOTTACLOUD_ROOTS": "/Archive",
        "JOTTACLOUD_READ_ONLY": "0"
      }
    }
  }
}
```

After first successful login, hosts can drop `JOTTACLOUD_LOGIN_TOKEN` if the token store is populated. For shareable project configs, use env placeholders (`${JOTTACLOUD_LOGIN_TOKEN}` / `${env:…}` / Codex `env_vars`) as documented in 03.

## Security defaults

1. **Default root scope:** only `/Archive` (override via `JOTTACLOUD_ROOTS`). Reject `..`, absolute escapes, and paths outside allow-list after normalize.
2. **Soft-delete only** in v1; hard-delete and trash purge stay unimplemented.
3. **`delete_file` requires `confirm: true`**; overwrite on `write_file` should document host approval + optional confirm.
4. **`JOTTACLOUD_READ_ONLY=1` supported** from day one (omit or stub write tools)—recommended default for first user install docs.
5. **Size caps:** list default limit 50–100; text read soft cap ~256–512 KB with `max_bytes` / head / tail; tool upload payload few MB max (not Silo-scale 5 GiB via LLM args).
6. **Credentials:** env + local token file only; never tool args; never stdout logs of secrets.
7. **Single-process token store:** document that concurrent MCP processes sharing one refresh token are unsafe (rotation).
8. **Prompt injection:** treat cloud file names/contents as untrusted; path scopes + confirms + read-only default mitigate exfil/delete.
9. **No browser CORS dependency:** local Node process calls Jotta APIs directly.

## Implementation plan

### Phase 1 — Auth client
- OIDC discovery / token exchange for personal login token (`jottacli`).
- Atomic token store + refresh with reuse-safe write.
- `account/v1/customer` → cached username.
- Smoke: authenticated `GET` of Archive root.

### Phase 2 — List / read
- Path join + sandbox against `JOTTACLOUD_ROOTS`.
- Tools: `list_roots`, `list_directory`, `get_file_info`, `read_file`.
- XML → structured tool results; pagination; read size caps.
- Optional: `jotta:///` resource template + `resources/read`.

### Phase 3 — Write / mkdir
- `create_directory` via `?mkDir=true`.
- `write_file` via `files/v1/allocate` + upload (handle `COMPLETED` dedup; basic resume/`Range` if easy).
- Respect `JOTTACLOUD_READ_ONLY`.
- Tool annotations for mutating tools.

### Phase 4 — Delete / move
- Soft `delete_file` (`dl` / `dlDir`) with mandatory `confirm`.
- `move_file` / rename (`mv` / `mvDir`).
- Fail closed on dest-exists unless explicit overwrite.

### Phase 5 — Polish
- Client-side `search_files` (liststream + filter).
- Retries on HTTP 429 with backoff; clearer `isError` messages.
- README with Claude / Codex / Cursor snippets (from 03).
- Packaging: npm `bin`, CI typecheck/test, optional Docker.
- Defer share links, hard-delete, HTTP transport, hosted OAuth.

## Open risks

| Risk | Mitigation |
|---|---|
| **Unofficial API** — no SLA; JFS / files/v1 can change | Thin client module; pin behavior to rclone/mifi patterns; version the package |
| **Refresh rotation / reuse** — multi-instance breaks sessions | Single store + file lock; document one server process per token |
| **No server-side search API** | Client-side filter; may be slow on huge trees—paginate and scope roots |
| **ToS / fair use** | Personal-token path; polite retries; no aggressive crawling |
| **Large binary in model context** | Caps + metadata-first; no unbounded base64 |
| **Special mountpoints** (Trash, Links, Shared) | Default Archive-only; expand roots carefully |
| **Trash restore / versions** | Soft-delete only; restore/versions via web UI until API is clear |
| **Host variance** | Tools-first so Codex/Claude/Cursor all work without relying on resources |

## Sources

- [research/01-jottacloud-api.md](./01-jottacloud-api.md) — OIDC personal login token (`jottacli`), JFS + files/v1 operations, refresh rotation, client inventory
- [research/02-mcp-storage-patterns.md](./02-mcp-storage-patterns.md) — tools-first surface, TypeScript + stdio, annotations, caps, filesystem/GDrive/Silo patterns
- [research/03-client-integration.md](./03-client-integration.md) — Claude Desktop/Code, Codex, Cursor config locations and stdio/env examples
