# Jottacloud in ChatGPT

Status: source implementation, 2026-10-01. This is a private integration to one service owner's Jottacloud account. It is not a public, multi-user connector or an official Jottacloud product. It has not been deployed or verified in a real ChatGPT session.

## What is included

- A portable MCP Apps file browser with OpenAI sidebar/thread entrypoint metadata.
- Configured root navigation, breadcrumbs, paginated listings and bounded file-name search. Search does not scan document text and explicitly reports limits.
- Safe text previews (rendered as text, never HTML) and small raster-image previews. SVG, PDF and Office previews/text extraction are not supported. Large images remain metadata-only.
- Explicit Use in conversation: select the file, add bounded source content and provenance through `ui/update-model-context`, then send the selection through `ui/message`. Viewing a preview does not send those bytes to the model. Host rejection is shown as an error rather than a success.
- An HTTP MCP exposing only these read operations. The existing optional stdio write tools are never registered by the HTTP service.
- A private OAuth authorization-code flow with S256 PKCE, exact owner-approved redirect URIs, browser consent, a separate connection password, short-lived access tokens, refresh rotation/replay rejection and revocation. OAuth token hashes are persisted separately from Jottacloud refresh tokens in a 0600 store. Existing grants are invalid when the issuer or configured root policy changes.
- Standalone Claude Code and portable OpenAI local plugin packages, both with the same shared skill and bundled stdio server.

## Run locally

Requires Node 20.19+ (Node 22 recommended).

```sh
npm ci
npm run build
npm test
npm run typecheck
npx playwright install chromium
npm run test:ui
```

For visual development, run `npm run dev:ui` and open `http://127.0.0.1:5173/qa.html`. This test-only host contains clearly synthetic files; it is excluded from `ui/index.html`. Open the actual app inside an MCP Apps host to exercise real data. Directly opening `index.html` without a host is not a Jottacloud login flow.

## Private HTTP service

Provision the Jottacloud session on the machine that will run the service, using the existing `--login` workflow. Keep the one-shot login token out of chat, shell history and manifests. Remove the bootstrap environment variable after successful login.

Use a dedicated `JOTTACLOUD_TOKEN_STORE` for the HTTP service. Do not share it with concurrent stdio clients. Use one service process/replica per store. The OAuth state store is also single-process; multiple replicas are not supported.

Set these variables through the host's secret/configuration facility:

| Variable | Requirement |
| --- | --- |
| `JOTTACLOUD_PUBLIC_URL` | Exact HTTPS origin, without a path. HTTP localhost is accepted only for local tests. |
| `JOTTACLOUD_ROOTS` | Smallest permitted roots, e.g. `/Sync/Documents`. Does not include Trash implicitly. |
| `JOTTACLOUD_TOKEN_STORE` | Dedicated persistent Jottacloud credential store. |
| `JOTTACLOUD_CONNECT_PASSWORD` | Separate, cryptographically random service password, at least 32 characters. This is not a Jottacloud token/password. Only the account owner should know it. |
| `JOTTACLOUD_OAUTH_REDIRECTS` | Comma-separated exact callback URLs copied from ChatGPT's connection-management page. No wildcard or guessed callback. |
| `JOTTACLOUD_OAUTH_STORE` | Optional override for the private OAuth state file; default is beside the Jottacloud token file. Persist it and keep it secret. |
| `HOST` / `PORT` | Default `127.0.0.1:8787`. Set `HOST=0.0.0.0` only behind the intended private deployment's HTTPS reverse proxy. |

Then run `npm run start:http`. `/healthz` reports process health only; it does not prove login or Jottacloud availability. Connect ChatGPT to `https://<your-host>/mcp`, choose OAuth/DCR with `jottacloud.read`, and approve read access using the service connection password on the service's consent page. Obtain the exact callback from ChatGPT before completing service configuration.

The service binds tokens to `/mcp`; ChatGPT receives service access tokens, never the upstream Jottacloud refresh token. The consent screen always identifies this as a private connection to the owner's account. Do not publish this single-account service as a connector for unrelated users. Giving someone the connection password gives them access to the owner's configured roots.

Deploy only after explicit authorization. The repo includes a Dockerfile for a single-process service with externally provisioned persistent credentials; it does not create or modify infrastructure. The HTTPS proxy must preserve the configured host and must not log form bodies, Authorization headers or OAuth callback query strings. The app does not trust forwarded IP headers; rate limiting behind a proxy is conservative and shared unless explicitly configured later.

## Local plugin installation

`npm run build` creates `artifacts/plugins/claude` and `artifacts/plugins/openai`. Each has a bundled Node server, `ui/index.html`, LICENSE and `skills/find-and-read/SKILL.md`.

Validate and test the Claude package before installation:

```sh
claude plugin validate ./artifacts/plugins/claude
claude --plugin-dir ./artifacts/plugins/claude
```

Expose the OpenAI folder through a local marketplace following OpenAI's package guide. It uses root `plugin.json` and `mcp.json` with the Agent Plugins schemas and `${PLUGIN_ROOT}` for its bundled server. Local installation is separate from public ChatGPT submission. No user marketplace/config files are changed by the build.

Both local packages force read-only mode and inherit configured roots from their host. They do not include credentials. If running both clients, log in independently with separate token stores/independent login tokens per client; never duplicate a rotating refresh-token store.

## Acceptance and remaining gates

Local automated checks cover root escapes and metadata filtering, paging/search limits, bounded downloads when Range is ignored, invalid binary text detection, OAuth consent/CSRF/PKCE/replay/token persistence, read-only HTTP tools, standalone plugin execution outside the repository, UI-resource delivery and the explicit preview-to-context transition. UI tests cover navigation, search, text safety, unsupported formats, host rejection and narrow-layout overflow. These checks use synthetic data.

Before calling this usable in ChatGPT:

1. Review and merge the implementation under explicit merge authorization.
2. Authorize a named deployment host and HTTPS origin, provision the account owner's dedicated token store and select the allowed roots.
3. Complete a real ChatGPT OAuth/DCR connection and check the actual host bridge, sidebar/thread entrypoints, navigation, preview and Use in conversation against known test files in those roots.
4. Verify denied paths and signed-out/expired-token behavior in that environment. Capture evidence without private file bytes or credentials.

Public distribution is a separate delivery: multi-user identities and token stores, isolated account authority, onboarding/account removal, public listing/privacy/support metadata and the provider's submission review. No UserInfo endpoint or verified email claim is fabricated by this private provider. PDF/Office extraction, native composer mentions, content search, uploads and write workflows are separate follow-ups.

## References

- https://developers.openai.com/plugins/build/extensions
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/guides/submit-claude-plugin
- https://code.claude.com/docs/en/plugins-reference
