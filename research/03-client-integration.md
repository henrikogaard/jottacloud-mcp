# Client Integration (Claude, Codex, Cursor)

## Summary

End users configure a local Jottacloud MCP server differently per client, but the **stdio shape is the same idea everywhere**: a named server entry with a launch `command`, optional `args`, and secrets in `env` (never committed). Remote/streamable-HTTP is also first-class in Claude Code, Codex, and Cursor; Claude Desktop/web “custom connectors” are a separate remote path brokered by Anthropic’s cloud.

| Client | Config format | Primary locations | Local transport | Remote transport |
| --- | --- | --- | --- | --- |
| **Claude Desktop** | JSON `mcpServers` | `claude_desktop_config.json` | stdio (manual + Desktop Extensions) | Custom connectors (URL/OAuth; cloud-originated) |
| **Claude Code** | JSON `mcpServers` | `.mcp.json`, `~/.claude.json` | stdio | HTTP (preferred), SSE (deprecated), WebSocket |
| **Codex** (CLI / ChatGPT desktop / IDE) | TOML `[mcp_servers.*]` | `~/.codex/config.toml`, project `.codex/config.toml` | stdio | Streamable HTTP (+ bearer / OAuth) |
| **Cursor** | JSON `mcpServers` | `~/.cursor/mcp.json`, `.cursor/mcp.json` | stdio | SSE + Streamable HTTP (+ headers / OAuth) |

**Practical recommendation for jottacloud-mcp:** ship a **stdio** package (e.g. `npx` / `uvx` / binary) with env vars for credentials, plus optional **streamable HTTP** for hosted/remote use. Document three config snippets: Claude Desktop JSON, Claude Code / Cursor JSON, and Codex TOML.

---

## Claude

### Claude Desktop (app)

**Official docs**

- [Getting started with local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Connect to local MCP servers (MCP docs; Claude Desktop walkthrough)](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

**Config file locations**

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Open via: Claude menu → **Settings…** → **Developer** → **Edit Config** (menu bar settings, not in-window account settings).

**JSON schema (stdio)**

Top-level object with `mcpServers` map. Each entry typically includes:

| Field | Role |
| --- | --- |
| `command` | Executable to spawn (`npx`, `node`, `uvx`, absolute path, etc.) |
| `args` | Argument array |
| `env` | Key/value environment for the child process (API keys, tokens) |

Example shape from official MCP docs:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Desktop"]
    }
  }
}
```

Fully **quit and restart** Claude Desktop after edits; config is loaded at startup.

**Install paths beyond manual JSON**

1. **Desktop Extensions** (`.mcpb`): Settings → Extensions; sensitive fields marked in the extension manifest are stored in OS keychain/credential manager.
2. **Custom connectors (remote MCP)**: Settings/Connectors UI with a public HTTPS URL + optional OAuth client id/secret. Free plan: one custom connector. Team/Enterprise: Owners add org connectors; members Connect individually.

**Remote vs local (important)**

- Local servers in `claude_desktop_config.json` run on the user’s machine (stdio).
- Remote custom connectors are reached **from Anthropic’s cloud IPs**, not the user’s LAN/VPN. Private network servers need Anthropic IP allowlisting. Local stdio is unavailable on claude.ai / Cowork the same way.

**Secrets**

- Manual JSON: put tokens in `env` (user-local file; do not commit).
- Extensions: UI-configured sensitive fields → OS secure storage.
- Remote connectors: OAuth (preferred) or connector advanced OAuth client settings.

**Approvals / tools**

- Local filesystem-style tools require **explicit user approval** before actions.
- Connectors: per-conversation enable/disable; review tool approval prompts; Research can invoke connector tools without further approval once granted—disable write tools when using Research.
- Status: `+` → Connectors, or Developer settings / logs under `~/Library/Logs/Claude` (macOS) or `%APPDATA%\Claude\logs` (Windows).

### Claude Code (CLI / IDE)

**Official docs**

- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [MCP quickstart](https://code.claude.com/docs/en/mcp-quickstart)

**Config locations and scopes**

| Scope | File | Visibility |
| --- | --- | --- |
| `local` (default) | `~/.claude.json` under the current project path | You only, this project |
| `project` | `.mcp.json` at project root | Team via VCS; needs interactive approval |
| `user` | `~/.claude.json` top-level `mcpServers` | You only, all projects |

Windows: `%USERPROFILE%\.claude.json`. Override home with `CLAUDE_CONFIG_DIR`.

**CLI**

```bash
# Remote HTTP (preferred for hosted servers)
claude mcp add --transport http <name> <url>
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"

# Local stdio (everything after -- is the server command)
claude mcp add --env JOTTACLOUD_TOKEN=YOUR_TOKEN --transport stdio jottacloud \
  -- npx -y @example/jottacloud-mcp

claude mcp list
claude mcp get <name>
# In-session: /mcp
```

**Transports**

| Type | Notes |
| --- | --- |
| `stdio` | Local process; default when using `command` |
| `http` | Streamable HTTP; `streamable-http` accepted as alias in JSON |
| `sse` | Deprecated; use HTTP when available |
| `ws` | WebSocket; JSON / `add-json` only; header auth, no OAuth via `mcp add --transport` |

Entries with `url` **must** set `"type": "http"` (or `sse` / `ws`); bare `url` without `type` is treated as misconfigured stdio.

**Env / secrets**

- CLI: `--env KEY=value` (repeatable).
- JSON: `"env": { "KEY": "value" }`, `"headers": { ... }` for HTTP.
- Project `.mcp.json` expansion: `${VAR}`, `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`.
- Stdio children get `CLAUDE_PROJECT_DIR` set to the project root.
- Optional `headersHelper` shell for dynamic auth headers (runs after workspace trust for project/local scope).
- OAuth: authenticate via `/mcp`; optional `oauth.clientId`, `callbackPort`, `scopes`, etc.

**Approvals / capabilities**

- Project `.mcp.json` servers need interactive approval (pending until `claude` session trust/approve). Non-interactive/`claude -p` may load without that prompt unless disabled.
- First tool use prompts for permission.
- Supports tools, prompts, resources; `list_changed` refreshes capabilities.
- Output limits: warn ~10k tokens, default max ~25k (`MAX_MCP_OUTPUT_TOKENS`); timeouts via `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, per-server `timeout` (ms).

**Import from Desktop**

`claude mcp add-from-claude-desktop` (name restrictions: letters, numbers, hyphens, underscores).

---

## Codex

**Official docs**

- [Model Context Protocol (Codex / ChatGPT)](https://developers.openai.com/codex/mcp) (same content as [learn.chatgpt.com MCP](https://learn.chatgpt.com/docs/extend/mcp))
- [Configuration reference](https://developers.openai.com/codex/config-reference) / [learn config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Sample `config.toml`](https://learn.chatgpt.com/docs/config-file/config-sample)
- [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)

**Where config lives**

| Scope | Path | Notes |
| --- | --- | --- |
| User | `~/.codex/config.toml` | Default shared by ChatGPT desktop app, Codex CLI, and IDE extension |
| Project | `.codex/config.toml` | Trusted projects only |

Table name is **`mcp_servers`** (underscore). Wrong keys are silently ignored.

**CLI / UI**

```bash
codex mcp add <server-name> --env VAR1=VALUE1 -- <stdio command and args...>
codex mcp add example --url https://mcp.example.com --oauth-client-id my-client
codex mcp list
codex mcp login <server-name>
# In TUI / composer: /mcp
```

ChatGPT desktop / IDE: Settings → MCP servers → Add server (STDIO or Streamable HTTP) → Restart.

**Stdio fields**

| Field | Required | Purpose |
| --- | --- | --- |
| `command` | yes | Launch command |
| `args` | no | Args |
| `env` | no | Explicit env map |
| `env_vars` | no | Forward named vars from local (or remote executor) env |
| `cwd` | no | Working directory |
| `experimental_environment` | no | `remote` for executor-backed stdio |

**Streamable HTTP fields**

| Field | Purpose |
| --- | --- |
| `url` | Server endpoint |
| `bearer_token_env_var` | Env var name whose value becomes `Authorization: Bearer …` |
| `http_headers` / `env_http_headers` | Static or env-sourced headers |
| `http_headers_helper` | Local command printing JSON header map |
| `auth` | `oauth` (default) or `chatgpt` for trusted first-party |

**Approvals / tool policy**

- `default_tools_approval_mode`: `auto` | `prompt` | `writes` | `approve` (`writes` prompts for non-read-only tools).
- Per-tool: `tools.<name>.approval_mode`, `output_token_limit`.
- Allow/deny: `enabled_tools`, `disabled_tools`.
- `enabled` / `required`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60).
- Global approval policy can also gate MCP elicitations (`approval_policy.granular.mcp_elicitations`).

**Feature notes**

- Documented support: **stdio**, **streamable HTTP**, bearer + OAuth (CIMD/DCR), ChatGPT session auth for trusted first-party, and MCP **`instructions`** (keep first ~512 chars self-contained for tool selection).
- ChatGPT **web** plugins use remote MCP differently and do **not** read local `config.toml`.

---

## Cursor

**Official docs**

- [MCP reference](https://cursor.com/docs/mcp)
- [MCP help / integrations](https://cursor.com/help/customization/mcp)

**Config locations**

| Scope | Path | Merge rule |
| --- | --- | --- |
| Project | `.cursor/mcp.json` | Shared with team; wins on name collision |
| Global | `~/.cursor/mcp.json` | All projects |

Also: Customize → MCPs (marketplace / one-click), enterprise Team MCP / allowlists.

**Transports**

| Transport | Config | Auth |
| --- | --- | --- |
| `stdio` | `command` (+ `args`, `env`, `envFile`) | Manual env / secrets |
| SSE | `url` | OAuth / headers |
| Streamable HTTP | `url` | OAuth / headers |

**Stdio fields** (docs mark `type: "stdio"` as required in the STDIO table; many examples omit `type` when `command` is present—prefer matching official examples for the client version you target)

| Field | Role |
| --- | --- |
| `command` / `args` | Spawn local server |
| `env` | Env map; supports `${env:NAME}` |
| `envFile` | Load `.env` (stdio only) |

**Remote**

```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer ${env:MY_SERVICE_TOKEN}"
      }
    }
  }
}
```

Static OAuth client credentials via `auth.CLIENT_ID` / `CLIENT_SECRET` / `scopes`. Redirect URLs to register: `https://www.cursor.com/agents/mcp/oauth/callback` (web/agents) and `http://localhost:8787/callback` (desktop).

**Interpolation** (in `command`, `args`, `env`, `url`, `headers`, `auth`): `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` / `${/}`.

**Protocol support**

Officially supported: **Tools**, **Prompts**, **Resources**, **Roots**, **Elicitation**, **MCP Apps** (interactive UI; degrades to normal tool results if UI unavailable).

**Approvals**

- Default: ask before MCP tool use.
- Run Modes / Auto-review (Cursor 3.6+): allowlisted tools may auto-run; others go through classifier. Configurable via Settings → Agents → Approvals & Execution and `permissions.json`.
- Toggle servers under Customize without deleting config.
- Logs: Output panel → **MCP Logs**.

**Cloud Agents**

Separate dashboard configuration (Team: Integrations & MCP); not the same as local `mcp.json` alone.

---

## Unified config recommendations

1. **Prefer stdio for personal local use** of jottacloud-mcp (credentials stay on device; works offline to the cloud API from the user’s machine).
2. **Same conceptual knobs everywhere:** `command` + `args` + `env` (JSON) or Codex TOML equivalents. Do not assume one file is shared across Claude / Codex / Cursor.
3. **Never put real secrets in committed project configs.** Use:
   - Claude Code / Cursor: `${ENV}` / `${env:ENV}` placeholders in shared `.mcp.json` / `.cursor/mcp.json`
   - Codex: `env_vars = ["JOTTACLOUD_TOKEN"]` or `bearer_token_env_var`
   - Claude Desktop: user-local `claude_desktop_config.json` only
4. **If offering remote HTTP:** implement **streamable HTTP**; document Cursor SSE URL only if you still expose SSE. Claude Desktop remote connectors require a **public** HTTPS endpoint reachable from Anthropic.
5. **Approvals differ:** Claude Desktop/Code prompt per tool (and project MCP trust); Codex has explicit `default_tools_approval_mode`; Cursor ties MCP to Agent run modes. Document “expect a confirmation on first write.”
6. **Resources/prompts:** Cursor and Claude Code advertise broader MCP surface (resources/prompts/roots). Codex docs emphasize tools + `instructions`. Design the Jottacloud server so **tools alone** deliver core value; treat resources as optional enrichment.
7. **README templates later:** three snippets below (Desktop JSON, shared JSON for Claude Code + Cursor, Codex TOML), plus env var table.

---

## Example mcp config snippets

Hypothetical local server: package `@jottacloud/mcp` (or a repo script), env vars `JOTTACLOUD_USERNAME` and `JOTTACLOUD_TOKEN` (placeholders only).

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jottacloud": {
      "command": "npx",
      "args": ["-y", "@jottacloud/mcp"],
      "env": {
        "JOTTACLOUD_USERNAME": "your-username",
        "JOTTACLOUD_TOKEN": "your-personal-login-token"
      }
    }
  }
}
```

### Claude Code — project `.mcp.json` (commit-safe placeholders)

```json
{
  "mcpServers": {
    "jottacloud": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@jottacloud/mcp"],
      "env": {
        "JOTTACLOUD_USERNAME": "${JOTTACLOUD_USERNAME}",
        "JOTTACLOUD_TOKEN": "${JOTTACLOUD_TOKEN}"
      }
    }
  }
}
```

CLI equivalent (values written into user-scope config; prefer `.mcp.json` + `${VAR}` for shareable setups):

```bash
claude mcp add --scope user \
  --env JOTTACLOUD_USERNAME=your-username \
  --env JOTTACLOUD_TOKEN=your-personal-login-token \
  --transport stdio jottacloud -- npx -y @jottacloud/mcp
```

### Cursor — `~/.cursor/mcp.json` or `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "jottacloud": {
      "command": "npx",
      "args": ["-y", "@jottacloud/mcp"],
      "env": {
        "JOTTACLOUD_USERNAME": "${env:JOTTACLOUD_USERNAME}",
        "JOTTACLOUD_TOKEN": "${env:JOTTACLOUD_TOKEN}"
      }
    }
  }
}
```

Optional remote:

```json
{
  "mcpServers": {
    "jottacloud": {
      "url": "https://mcp.example.com/jottacloud",
      "headers": {
        "Authorization": "Bearer ${env:JOTTACLOUD_TOKEN}"
      }
    }
  }
}
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.jottacloud]
command = "npx"
args = ["-y", "@jottacloud/mcp"]
env_vars = ["JOTTACLOUD_USERNAME", "JOTTACLOUD_TOKEN"]
startup_timeout_sec = 30
default_tools_approval_mode = "writes"

[mcp_servers.jottacloud.env]
# Prefer env_vars for secrets already in the shell; use env only for non-secret defaults
JOTTACLOUD_API_BASE = "https://api.jottacloud.com"
```

Remote HTTP variant:

```toml
[mcp_servers.jottacloud]
url = "https://mcp.example.com/jottacloud"
bearer_token_env_var = "JOTTACLOUD_TOKEN"
default_tools_approval_mode = "prompt"
```

CLI:

```bash
codex mcp add jottacloud \
  --env JOTTACLOUD_USERNAME=your-username \
  --env JOTTACLOUD_TOKEN=your-personal-login-token \
  -- npx -y @jottacloud/mcp
```

---

## Sources

### Claude / Anthropic

- [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) (Model Context Protocol docs)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [MCP quickstart (Claude Code)](https://code.claude.com/docs/en/mcp-quickstart)

### OpenAI Codex / ChatGPT

- [Model Context Protocol – Codex](https://developers.openai.com/codex/mcp)
- [Model Context Protocol – ChatGPT Learn](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Configuration reference (Learn)](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample)
- [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)

### Cursor

- [Model Context Protocol (Cursor Docs)](https://cursor.com/docs/mcp)
- [MCP integrations (Cursor Help)](https://cursor.com/help/customization/mcp)
