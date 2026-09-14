# MCP Storage Server Patterns

## Summary

High-quality storage MCPs treat **tools as the primary agent surface** (list/read/write/search/mkdir/move/delete) and use **resources** as an optional, application-driven read path (URI → content), not as a substitute for mutation. The reference local server is `@modelcontextprotocol/server-filesystem` (path sandbox + Roots + tool annotations). The closest cloud analogue in the official family is `@modelcontextprotocol/server-gdrive` (search tool + `gdrive:///<file_id>` resources, read-only OAuth). Multi-cloud community servers (e.g. Silo MCP) add confirm gates, upload/download roots, size caps, and OS keyring credentials—patterns a Jottacloud MCP should copy.

**Stack pick for Jottacloud:** TypeScript + official MCP server SDK, **stdio-first** packaging (`npx` / local `node`), with optional Streamable HTTP later. Prefer a small, annotated tool set over a 50+ action mirror of the full Jottacloud API.

## Protocol & transports

### Primitives (who controls what)

| Primitive | Control model | Role for storage |
| --- | --- | --- |
| **Tools** | Model-controlled; host SHOULD keep a human in the loop | Browse, search, read, write, mkdir, move, delete, share |
| **Resources** | Application-driven; host chooses how to surface/select | Stable URI read of a known file; templates for path/id; optional subscribe |
| **Prompts** | User-controlled templates | Optional: “summarize this folder”, “organize Downloads” — not required for v1 |

Sources: [MCP specification overview (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25), [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts).

**Resources specifics useful for storage:**

- List/read support **cursor pagination** (`cursor` / `nextCursor`).
- Contents are either `text` or base64 `blob` with `mimeType`.
- **Resource templates** (e.g. `file:///{path}`, `jotta:///{path}`) avoid enumerating every file in `resources/list`.
- Custom URI schemes are allowed (RFC 3986); `file://` may represent logical FS-like trees, not only local disk.
- Error for missing resource: JSON-RPC `-32002`.

**Tools specifics useful for storage:**

- `tools/list` and `tools/call`; results use `content[]` (`text`, `image`, `audio`, `resource_link`, embedded `resource`) and optional `structuredContent` / `outputSchema`.
- Tool **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) help hosts gate approval UX—used heavily by the official filesystem server.
- Execution errors should return `isError: true` with actionable text (so the model can self-correct); protocol errors are for unknown tools / bad request shape.

**Roots (client → server boundary):**

- Clients that support Roots declare `capabilities.roots` and answer `roots/list` with `file://` URIs.
- Servers SHOULD respect those boundaries; filesystem MCP replaces CLI allow-lists when Roots are provided.
- Spec: [Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots). For cloud drives, map the idea to **scoped remote prefixes** (e.g. only `/Archive`) even if URIs are not `file://`.

### Transports

Per [Transports (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):

1. **stdio** — Client launches subprocess; newline-delimited JSON-RPC on stdin/stdout; stderr for logs only. **Clients SHOULD support stdio whenever possible.** This is the default for Claude Desktop, Cursor local servers, and Codex CLI.
2. **Streamable HTTP** — Single MCP endpoint; client POSTs JSON-RPC; server replies with `application/json` or `text/event-stream` (SSE). Replaces deprecated **HTTP+SSE** (2024-11-05). Requires Origin validation, localhost binding when local, and auth.

**Cursor** documents three transports: `stdio`, `SSE` (legacy), `Streamable HTTP` ([Cursor MCP docs](https://cursor.com/docs/mcp.md)). Prefer stdio for personal Jottacloud tokens; use Streamable HTTP only if hosting a shared connector.

## Comparable servers

### 1. Official Filesystem MCP (gold standard for FS semantics)

- **Package / source:** [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem), [src/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- **Docs:** [README](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md), [Connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

**Tools exposed:**

| Tool | Notes |
| --- | --- |
| `read_text_file` | UTF-8; optional `head` / `tail` (large-file friendly) |
| `read_media_file` | Base64; image/audio as typed content, other binary as embedded resource |
| `read_multiple_files` | Batch read; failures don’t abort siblings |
| `write_file` / `edit_file` | Full overwrite vs selective edits (`dryRun`) |
| `create_directory` | Parents created; idempotent |
| `list_directory` / `list_directory_with_sizes` | `[FILE]`/`[DIR]` prefixes; optional size sort |
| `directory_tree` | Recursive JSON tree + exclude globs |
| `move_file` | Rename/move; fails if destination exists |
| `search_files` | Glob from a root path + excludes |
| `get_file_info` | Size, times, type, permissions |
| `list_allowed_directories` | Expose current sandbox |

**Path naming:** Ordinary absolute OS paths; validated against allowed directories via normalize + `realpath`/symlink-aware checks ([`path-validation.ts`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/path-validation.ts)).

**Large / binary:** Prefer `head`/`tail` and streaming reads for tails; media returned as base64 content blocks (implicit size risk—callers should avoid dumping huge binaries into the model context). Docker mounts can be `ro` for read-only.

**Security:** CLI dirs and/or MCP Roots; `list_allowed_directories`; tool annotations mark read-only vs destructive; Docker sandbox mounts under `/projects`.

### 2. Official Google Drive MCP (cloud resource pattern)

- **Package:** [`@modelcontextprotocol/server-gdrive`](https://www.npmjs.com/package/@modelcontextprotocol/server-gdrive) (Anthropic / MCP reference; last published `2025.1.14`)
- **Note:** Removed from the live `servers` monorepo tree (current `src/` has filesystem, fetch, git, memory, …)—still the clearest *official* cloud-drive shape.

**Surface:**

- **Tool:** `search` — query string → names + MIME types.
- **Resources:** `gdrive:///<file_id>` — Workspace export (Docs→Markdown, Sheets→CSV, Slides→text, Drawings→PNG); other files native.
- **Auth:** Desktop OAuth; scope `drive.readonly`; credentials file / Docker volume (`GDRIVE_CREDENTIALS_PATH`); keys via `gcp-oauth.keys.json`.

**Takeaway for Jottacloud:** Use **opaque IDs or stable paths in a custom URI scheme** for resource reads; keep search (and mutations) as tools. Read-only first is a proven cloud pattern.

### 3. Silo MCP (multi-cloud: Dropbox, Drive, OneDrive, Box, S3, …)

- **Source:** [gouthamkallempudi/silo-mcp](https://github.com/gouthamkallempudi/silo-mcp)

**Unified tools:** `list_files`, `search_files`, `upload_file`, `download_file`, `delete_file`, `create_share_link`, `copy_file`, plus account listing / capability probes / transfer audit.

**Patterns to copy:**

- Document stores use **path** (or Drive **file id**); object stores use **bucket + key** (`target`).
- **Confirm gates** (`confirm=true`) on upload, delete, share, cross-cloud copy.
- **Local path sandbox:** `SILO_MCP_UPLOAD_ROOT` / `SILO_MCP_DOWNLOAD_ROOT` (defaults under `~/silo-mcp/…`).
- **Size caps:** 5 GiB upload/download; downloads streamed and aborted over cap.
- **Credentials:** OS keyring via `keyring`, never in tool args or plaintext DB.
- Mutations/share treated as exfiltration-sensitive even when not “deleting.”

### 4. Other cloud storage MCP surfaces (secondary)

| Server | Approach | Caution |
| --- | --- | --- |
| [Apideck File Storage MCP](https://www.apideck.com/mcp-server/file-storage-api) | CRUD tools per resource type (files, folders, shared links, drives, upload sessions) across Drive/Dropbox/OneDrive/Box/SharePoint | Commercial aggregator; good taxonomy, not a reference implementation |
| [StackOne OneDrive/etc.](https://www.stackone.com/connectors/microsoftonedrive/mcp/) | Dozens of fine-grained actions (e.g. 46 for OneDrive) | Over-wide tool lists hurt agent performance—avoid for v1 |
| [OpenList MCP](https://github.com/hbestm/openlist-mcp-server) | ~79 tools: list/search/mkdir/move/delete/upload base64/share/tasks | Useful ops inventory; too large as a default surface |
| [piotr-agier/google-drive-mcp](https://github.com/piotr-agier/google-drive-mcp) | Large Drive/Docs/Sheets tool set; stdio + Streamable HTTP; optional `gdrive:///` resources | Shows full Workspace ambition; start narrower for Jottacloud |

## Recommended tool/resource surface for Jottacloud

### Design principles

1. **Tools-first for the agent.** Hosts (Claude/Cursor/Codex) reliably invoke tools; resources are unevenly auto-selected.
2. **Keep the tool count small (~8–12).** Prefer one `list`/`read`/`write` over dozens of API-shaped endpoints.
3. **Annotate every tool** (`readOnlyHint`, `destructiveHint`, `idempotentHint`; set `openWorldHint: true` for cloud).
4. **Pagination & caps on every listing/search/read.** Never return unbounded directory dumps or multi‑MB base64 by default.
5. **Path model:** Use Jottacloud absolute paths (`/Archive/foo.pdf`) as the primary identifier; if the API has stable IDs, accept optional `id` and return both in list/metadata. Resource URI: `jotta:///<urlencoded-path>` or `jotta:///<file-id>`.
6. **Read path duality:** Implement `read_file` tool *and* optional `resources/read` for the same URI so hosts that prefer resources can attach files in UI.

### Proposed tools (v1)

| Tool | readOnly | Confirm? | Notes |
| --- | --- | --- | --- |
| `list_directory` | yes | no | `path`, `cursor`/`limit`; return name, type, size, modified, path/id |
| `get_file_info` | yes | no | Metadata only |
| `search_files` | yes | no | Query + optional root path; paginate |
| `read_file` | yes | no | Text if UTF-8 text under size cap; else metadata + optional base64 chunk / download URL / “too large” guidance; `offset`/`max_bytes` or `head`/`tail` |
| `write_file` | no | recommended | Create/overwrite; text or base64; size cap |
| `create_directory` | no | optional | Idempotent mkdir |
| `move_file` | no | recommended | Move/rename; fail or require `overwrite` |
| `delete_file` | no | **required** (`confirm=true`) | Soft-delete if API supports trash |
| `list_roots` / `list_devices` | yes | no | Jottacloud-specific: Sync/Backup/Archive/Shares if applicable |

**Optional v1.1:** `create_share_link` (confirm), `download_to_local` (sandboxed local download root for bridging other MCPs), `copy_file`.

### Resources vs tools

| Capability | Prefer | Why |
| --- | --- | --- |
| List / search / mutate | **Tools** | Model-driven; need args, pagination, confirms |
| Open a known file in host UI | **Resource** (+ template) | Application-driven attach/browse |
| “Summarize my Archive” workflow | Optional **Prompt** | User slash-command, not agent discovery |

Do **not** rely on `resources/list` enumerating an entire cloud account—use templates + tools.

### Large files / binary / pagination

- Listings: `limit` (default 50–100) + opaque `cursor`.
- Text reads: soft cap (e.g. 100–500 KB) with explicit `max_bytes`; support `head`/`tail`.
- Binary: return MIME + size + checksum; only embed small base64; for large blobs prefer temporary download URL (if Jottacloud allows) or sandboxed local download tool.
- Uploads: stream from client-provided content with hard max (Silo uses 5 GiB; for LLM tool payloads prefer much lower, e.g. few MB, unless using a staged upload session).
- Tool results that point at files can use `resource_link` content type (URI for later `resources/read`).

## Security & credentials

### Protocol-level expectations

From the [spec security section](https://modelcontextprotocol.io/specification/2025-11-25) and tools/resources pages:

- User consent for data access and tool invocation.
- Servers MUST validate inputs/URIs; sanitize outputs; rate-limit tools.
- Clients SHOULD confirm sensitive ops and show arguments before call.
- Treat tool annotations as untrusted unless the server is trusted.
- Streamable HTTP: validate `Origin`, prefer localhost bind, require auth.

### Patterns to implement for Jottacloud

1. **Scoped remote roots** — Config allow-list of path prefixes (analogue of filesystem Roots / CLI dirs). Reject `..` and escapes after normalization.
2. **Read-only mode** — Env flag (e.g. `JOTTA_MCP_READ_ONLY=1`) that omits or no-ops write tools and mirrors GDrive’s readonly scope.
3. **Confirm gates** — Require `confirm: true` on delete (and share/overwrite); pair with host approval UI.
4. **Credential storage** — Prefer OS keychain / env vars in client config (`env` in Claude/`mcp.json`/Codex); never accept tokens as tool arguments; never log secrets. OAuth refresh offline if Jottacloud supports it; otherwise personal access / device login documented clearly.
5. **Least privilege** — Prefer tokens limited to needed mounts (Archive-only vs full account).
6. **Local bridge sandbox** — If downloading to disk for other tools, confine to a dedicated download root (Silo pattern).
7. **Docker packaging** — Optional image with volume for credential store and no host FS except explicit mounts (as filesystem/gdrive Docker examples).

### Prompt injection

Assume file names and file contents can instruct the model to exfiltrate or delete. Mitigations: path scopes, confirms, read-only default for first release, no home-directory upload root.

## Implementation stack recommendation

### Language / SDK

| Option | Pros | Cons |
| --- | --- | --- |
| **TypeScript + `@modelcontextprotocol/server` (v2)** | Matches official filesystem server ecosystem; stdio + HTTP adapters; strong Zod schemas; npm/`npx` packaging for Desktop/Cursor | Node 20+; v1→v2 package split (`@modelcontextprotocol/sdk` → `@modelcontextprotocol/server`) |
| **Python + `mcp` (`MCPServer`, `mcp[cli]`)** | Fast prototyping; `uvx` packaging; Silo-style keyring easy | Slightly less alignment with the highest-visibility reference FS server |

**Recommendation:** **TypeScript (stdio-first)** for Jottacloud MCP v1, using the current official server package documented at [ts.sdk.modelcontextprotocol.io](https://ts.sdk.modelcontextprotocol.io/v2/) and [npm `@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server). Use Python only if the chosen Jottacloud client library is Python-only and wrapping would dominate.

Ship a thin CLI binary / `package.json` `bin` so hosts can run:

```bash
npx -y @scope/jottacloud-mcp
# or: node dist/index.js
```

### Host packaging cheat sheet

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "jottacloud": {
      "command": "npx",
      "args": ["-y", "@scope/jottacloud-mcp"],
      "env": {
        "JOTTA_TOKEN": "…"
      }
    }
  }
}
```

Guide: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

**Cursor** — `.cursor/mcp.json` or `~/.cursor/mcp.json`; stdio `command`/`args`/`env` or remote `url`; supports Roots, Resources, Prompts ([Cursor MCP](https://cursor.com/docs/mcp.md)).

**Codex (CLI / IDE / ChatGPT desktop share config)** — `~/.codex/config.toml` or project `.codex/config.toml`:

```toml
[mcp_servers.jottacloud]
command = "npx"
args = ["-y", "@scope/jottacloud-mcp"]
```

Reference: [Codex config reference](https://developers.openai.com/codex/config-reference), [ChatGPT MCP extend docs](https://learn.chatgpt.com/docs/extend/mcp.md).

### Transport choice for Jottacloud

- **Default:** stdio + per-user credentials (personal cloud sync use case).
- **Later:** Streamable HTTP + OAuth if offering a hosted multi-user connector (follow MCP HTTP security warnings).

## Sources

### MCP specification & docs

- [Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)
- [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

### Reference & comparable servers

- [modelcontextprotocol/servers — filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [filesystem README](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md)
- [path-validation.ts](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/path-validation.ts)
- [@modelcontextprotocol/server-filesystem (npm)](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem)
- [@modelcontextprotocol/server-gdrive (npm)](https://www.npmjs.com/package/@modelcontextprotocol/server-gdrive)
- [gouthamkallempudi/silo-mcp](https://github.com/gouthamkallempudi/silo-mcp)
- [piotr-agier/google-drive-mcp](https://github.com/piotr-agier/google-drive-mcp)
- [Apideck File Storage MCP](https://www.apideck.com/mcp-server/file-storage-api)
- [OpenList MCP server](https://github.com/hbestm/openlist-mcp-server)

### SDKs & host packaging

- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [@modelcontextprotocol/server (npm)](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [Cursor MCP documentation](https://cursor.com/docs/mcp.md)
- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [ChatGPT / Codex MCP](https://learn.chatgpt.com/docs/extend/mcp.md)
