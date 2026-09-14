# Jottacloud API & Auth

## Summary

There is **no official public developer API** with documentation, SDK, or developer portal. Jottacloud’s help center documents only end-user products (web, desktop, mobile, and the official **jotta-cli**). The HTTP surface used by those clients—and by every serious third-party client—is a **de facto / reverse-engineered REST API**:

| Surface | Base URL | Format | Role |
|---|---|---|---|
| **JFS** (Jottacloud File System) | `https://jfs.jottacloud.com/jfs/` (also historically `https://www.jottacloud.com/jfs/`) | XML | List / metadata / download / mkdir / delete / move / share |
| **Files v1** (“Allocate API”) | `https://api.jottacloud.com/files/v1/` | JSON | Upload allocation, resume, trash purge |
| **Account v1** | `https://api.jottacloud.com/account/v1/` | JSON | Customer / username resolution |
| **OIDC / Keycloak** | `https://id.jottacloud.com/auth/realms/jottacloud/` | OAuth2/OIDC | Auth (personal login token → access + refresh tokens) |

**Auth recommendation for an MCP server:** use the same **standard / personal login token** flow as official `jotta-cli` and rclone (`client_id=jottacli`), store refresh tokens carefully (rotation + reuse detection), and call JFS + Files v1 with `Authorization: Bearer <access_token>`.

**Must-have MCP endpoints (from working clients):** list (`GET` JFS path), download (`GET …?mode=bin`), upload (`POST files/v1/allocate` + `POST upload_url`), mkdir (`POST …?mkDir=true`), soft/hard delete (`dl`/`rm`, `dlDir`/`rmDir`), move (`mv` / `mvDir`), share (`enableShare` / `disableShare`), trash purge (`POST files/v1/purge_trash`), customer info (`GET account/v1/customer`). **Search** has no confirmed public file-search HTTP endpoint in open clients—plan client-side listing/`liststream` or treat as unknown.

---

## Authentication

### Official stance

- Official docs describe **personal login tokens** for the CLI: generate at [https://www.jottacloud.com/web/secure](https://www.jottacloud.com/web/secure), then `jotta-cli login` ([Login and basic use with Jottacloud CLI](https://docs.jottacloud.com/en/articles/1437248-login-and-basic-use-with-jottacloud-cli)).
- CLI release notes: auth switched from username/password to personal login tokens ([Release notes](https://docs.jottacloud.com/en/articles/1461561-release-notes-for-jottacloud-cli)).
- There is **no** published OAuth app registration / developer guide for third parties.

### Live OIDC discovery (primary)

Fetched 2026-09-09 from  
`https://id.jottacloud.com/auth/realms/jottacloud/.well-known/openid-configuration`:

- Issuer: `https://id.jottacloud.com/auth/realms/jottacloud`
- Authorization: `…/protocol/openid-connect/auth`
- Token: `…/protocol/openid-connect/token`
- Supported grants include: `authorization_code`, `refresh_token`, `password`, `client_credentials`, `device_code`, CIBA
- Scopes include: `openid`, `offline_access`, `profile`, `email`, `jotta-default`, `full`, …

### Mechanisms used in practice

#### 1. Standard — personal login token (recommended)

Documented by rclone and mirrored by mifi/jotta and JaFS:

1. User generates a **one-shot personal login token** in Security settings (`/web/secure`).
2. Token is **base64url** encoding of JSON:

```json
{
  "username": "<internal-username>",
  "realm": "…",
  "well_known_link": "https://id.jottacloud.com/auth/realms/jottacloud/.well-known/openid-configuration",
  "auth_token": "<secret>"
}
```

Source: rclone `api.LoginToken` in [`backend/jottacloud/api/types.go`](https://github.com/rclone/rclone/blob/master/backend/jottacloud/api/types.go).

3. Client exchanges it via **Resource Owner Password Credentials**-style grant against the token endpoint:

| Field | Value |
|---|---|
| `client_id` | `jottacli` (shows as “Jottacloud CLI” under My logged in devices) |
| `grant_type` | `password` |
| `username` | from login token |
| `password` | `auth_token` from login token |
| `scope` | `openid offline_access` |

Source: rclone `doTokenAuth` in [`backend/jottacloud/jottacloud.go`](https://github.com/rclone/rclone/blob/master/backend/jottacloud/jottacloud.go); mifi/jotta `authenticate()` in [`src/api.ts`](https://github.com/mifi/jotta/blob/master/src/api.ts).

4. Response: OAuth access token + refresh token. Access tokens typically expire in **~1 hour**. Subsequent API calls use `Authorization: Bearer <access_token>`.

#### 2. Traditional — browser OAuth (white-label / optional)

- Interactive authorization_code flow against service-specific realms.
- rclone: limited to **one active session** on a machine; conflicts with desktop client.
- Less suitable for headless MCP than personal login tokens.

#### 3. Legacy — username/password (+ 2FA)

- Old endpoint family: `https://api.jottacloud.com/auth/v1/token` and `/auth/v1/register`.
- rclone still has code; documents **no known services** still using it; planned removal.
- **2FA (legacy only):** first password grant fails; response header `X-JottaCloud-OTP: required; SMS`; retry with header `X-Jottacloud-Otp: <code>` (`doLegacyAuth` in rclone).
- **Standard personal-login-token flow:** 2FA is handled in the **web UI when generating the token**; open clients do not send OTP headers on that path.

### Refresh token quirks (critical for MCP)

From [rclone Jottacloud docs](https://rclone.org/jottacloud/):

- **Refresh Token Rotation:** each refresh issues a new refresh token and invalidates the old one.
- **Automatic Reuse Detection:** reusing an old refresh token can invalidate the **entire token family** → `invalid_grant` / “Session doesn't have required client”.
- Implication: MCP must persist the **latest** refresh token atomically; do not share one remote config across multiple concurrent processes without coordination.
- Sessions appear under **Settings → Security → My logged in devices** and can be revoked.

### Device / “username” note

- Login token / customer API expose an **internal username** (opaque id string), not necessarily the user’s email.
- rclone resolves customer via `GET https://api.jottacloud.com/account/v1/customer` then uses that username in JFS paths.

---

## File operations

Path model (JFS):

```text
https://jfs.jottacloud.com/jfs/{username}/{device}/{mountpoint}/{folder…}/{file}
```

Defaults used by rclone / mifi/jotta / CLI-style tools:

- Device: `Jotta`
- Mountpoint: `Archive` (also common: `Sync`; special: `Trash`, `Links`, `Shared`, `Latest` — limited / non-folder semantics)

Responses for navigation are **XML**. Upload allocate / account are **JSON**.

### Catalog of operations (as implemented by rclone unless noted)

| Operation | Method | Endpoint / query | Notes |
|---|---|---|---|
| Account / internal username | `GET` | `api…/account/v1/customer` | JSON `CustomerInfo` |
| Drive / devices | `GET` | `jfs…/jfs/{username}` | XML |
| List folder / file metadata | `GET` | `jfs…/jfs/{user}/{device}/{mount}/…` | XML folder/file |
| Recursive list stream | `GET` | same + `?mode=liststream` | rclone `--fast-list`; streaming XML |
| Download file bytes | `GET` | same + `?mode=bin` | Supports Range via HTTP options |
| Thumbnail | `GET` | `?mode=thumb&ts=WS\|WM\|WL\|WXL` | mifi/jotta |
| Create directory | `POST` | path + `?mkDir=true` | |
| Soft-delete file | `POST` | path + `?dl=true` | Trash (~30 days) |
| Hard-delete file | `POST` | path + `?rm=true` | Permanent |
| Soft-delete dir | `POST` | path + `?dlDir=true` | |
| Hard-delete dir | `POST` | path + `?rmDir=true` | |
| Move file | `POST` | src path + `?mv={destPath}` | dest is absolute JFS-style path |
| Copy file | `POST` | src + `?cp={destPath}` | |
| Move directory | `POST` | src + `?mvDir={destPath}` | |
| Dedup / restore-by-hash | `POST` | path + `?cphash=true` + headers `JSize`, `JMd5`, `JCreated`, `JModified` | Can restore from trash if hash matches |
| Enable share | `GET` | path + `?mode=enableShare` | Returns `publicURI` / share path |
| Disable share | `GET` | path + `?mode=disableShare` | |
| Public download URL | (constructed) | `https://www.jottacloud.com/opin/io/downloadPublic/{user}/{publicURI}` | From rclone / mifi |
| Allocate upload | `POST` | `api…/files/v1/allocate` | JSON body: `bytes`, `md5`, `path`, `created`, `modified` |
| Upload body | `POST` | `upload_url` from allocate | `Content-Type: application/octet-stream`; optional `Range` for resume |
| Empty trash | `POST` | `api…/files/v1/purge_trash` | JSON |
| Create device | `POST` | `jfs…/{user}/{device}?type=WORKSTATION` | rclone |
| Create mountpoint | `POST` | `jfs…/{user}/{device}/{mount}` | rclone |

Allocate path form used by rclone: `/jfs/{device}/{mountpoint}/…` (device-relative, not including username) inside JSON `path`.

Allocate response fields (rclone `AllocateFileResponse`): `name`, `path`, `state`, `upload_id`, `upload_url`, `bytes`, `resume_pos`. If `state == COMPLETED`, content already present (dedup)—no upload needed.

Chunked upload quirk (jotta-fs / community): incomplete chunk may return **HTTP 420** + `IncompleteUploadOpenApiException`; resume via `resume_pos` ([jotta-fs docs](https://docs.rs/jotta-fs/latest/jotta_fs/)).

### Search

- **No confirmed dedicated file-search HTTP API** in rclone, mifi/jotta, or JaFS.
- Product marketing mentions AI **photo** search on the website; that surface is not documented for third-party HTTP clients (mifi/jotta TODO mentions an undocumented **Protobuf** API used by the official app).
- Practical approach for MCP: recursive `list` / `liststream` + local filter, or leave search as future/unknown.

### Versions, trash, quotas

- File versioning exists; rclone only exposes **current** revision; older versions via web UI.
- Soft-deleted items sit in trash ≥ **30 days** (rclone docs / JaFS).
- Quota: JFS drive XML `capacity`/`usage`, or customer JSON `usage`/`quota`. ToS also mentions API/bandwidth limits under fair use (no numeric public rate limit).

### Rate limits & client pacing

- **No published numeric rate limits.**
- ToS §15: *“Limitations on bandwidth and the number of api calls may occur.”* ([Terms](https://docs.jottacloud.com/en/articles/1372744-jottacloud-terms-conditions))
- rclone retries HTTP **429** with exponential backoff (`minSleep` 10ms → `maxSleep` 2s).

### API versions / dual stack

- **JFS**: older XML API; still primary for navigation and many mutations.
- **api.jottacloud.com `files/v1`**: newer JSON for upload allocate + trash purge.
- Official clients use **both** (JaFS README; rclone).
- Separate undocumented **Protobuf** API allegedly used by mobile/desktop app (mifi/jotta README TODO)—treat as out of scope unless reverse-engineered later.

---

## Existing clients

| Client | Language | Evidence quality | What it actually calls |
|---|---|---|---|
| **[rclone](https://rclone.org/jottacloud/)** [`backend/jottacloud/`](https://github.com/rclone/rclone/blob/master/backend/jottacloud/jottacloud.go) | Go | Best maintained reference | Full JFS + allocate upload + OIDC personal token / traditional / legacy; constants `jfsURL`, `apiURL`, `defaultClientID=jottacli`, `defaultTokenURL` |
| **Official [jotta-cli](https://docs.jottacloud.com/en/collections/178055-our-command-line-tool)** | Closed binary | Official auth UX only | Personal login token login; CLI ops (`ls`, `download`, `archive`, `share`, `trash`)—HTTP not documented |
| **[mifi/jotta](https://github.com/mifi/jotta)** | TypeScript | Modern thin client | Same auth + JFS list/download/share/thumbs + `account/v1/customer`; read-focused; notes CORS + Protobuf TODO |
| **[albertony/jafs](https://github.com/albertony/jafs)** | C# | Detailed conceptual map | JFS URL layout, devices/mountpoints, token auth update (2021); still JFS upload path historically |
| **[havardgulldahl/jottalib](https://github.com/havardgulldahl/jottalib)** | Python | Older; cites founder forum | Classic JFS wrapper; write support reverse-engineered; may lag current OIDC |
| **[jotta-fs](https://crates.io/crates/jotta-fs)** | Rust | Upload allocate notes | Documents `POST …/files/v1/allocate`, chunk/`Range`, HTTP 420 incomplete |
| **Duplicati** (historic PR) | C# | Secondary | Built on jottalib-era multipart JFS upload; confirms unofficial API |

Company staff historically acknowledged tinkering with the HTTP API (forum threads cited by JaFS/jottalib; one write-support thread archived). Forum URLs `forum.jotta.no` are largely dead; treat quotes as historical, not current policy.

---

## Risks & unknowns

| Risk | Detail |
|---|---|
| **Unofficial / unsupported** | No official API docs or SLA; endpoints can change without notice. |
| **ToS** | Trade-secret language on service structure; fair-use may throttle API calls; password must not be shared with third parties—personal login tokens are the intended CLI path, but legal review for distributing an MCP that talks to private endpoints is still advisable. |
| **Token rotation** | Refresh reuse breaks all sessions using that family—easy to get wrong in multi-instance MCP. |
| **Stability** | Dual XML/JSON APIs; special mountpoints behave oddly; copy-to-trashed-dest bug noted in rclone. |
| **Search** | Unknown HTTP API; AI photo search likely app-only/Protobuf. |
| **Trash restore** | Soft-delete known; explicit restore endpoint not clearly exposed (JaFS: “haven't found any API query that works”; rclone can restore via `cphash` match). |
| **2FA on modern auth** | Handled at token generation in browser; legacy OTP headers not used for `jottacli` password-grant exchange. |
| **CORS** | JFS not browser-callable cross-origin (mifi/jotta)—MCP should be a local/server process. |
| **White-label** | Same JFS/API family may differ in auth; MCP should target jottacloud.com first. |
| **Protobuf app API** | Existence claimed; no open schema found in this research pass. |

---

## Sources (with URLs)

### Official

- [Jottacloud CLI collection](https://docs.jottacloud.com/en/collections/178055-our-command-line-tool)
- [Login and basic use with Jottacloud CLI](https://docs.jottacloud.com/en/articles/1437248-login-and-basic-use-with-jottacloud-cli) — personal login token at `/web/secure`
- [Jottacloud CLI release notes](https://docs.jottacloud.com/en/articles/1461561-release-notes-for-jottacloud-cli) — password → personal login token
- [Jottacloud Terms & Conditions](https://docs.jottacloud.com/en/articles/1372744-jottacloud-terms-conditions) — fair use / API call limitations
- [OIDC discovery (live)](https://id.jottacloud.com/auth/realms/jottacloud/.well-known/openid-configuration)
- Security settings UI: [https://www.jottacloud.com/web/secure](https://www.jottacloud.com/web/secure)

### Primary client source (de facto API)

- [rclone Jottacloud docs](https://rclone.org/jottacloud/)
- [rclone `jottacloud.go`](https://github.com/rclone/rclone/blob/master/backend/jottacloud/jottacloud.go) — endpoints, auth, operations
- [rclone `api/types.go`](https://github.com/rclone/rclone/blob/master/backend/jottacloud/api/types.go) — LoginToken, allocate structs, XML models
- [mifi/jotta `src/api.ts`](https://github.com/mifi/jotta/blob/master/src/api.ts) — modern TS client
- [mifi/jotta README](https://github.com/mifi/jotta) — CORS, Protobuf TODO
- [albertony/jafs README](https://raw.githubusercontent.com/albertony/jafs/master/README.md) — JFS layout, dual API, staff endorsement history
- [havardgulldahl/jottalib](https://github.com/havardgulldahl/jottalib)
- [jotta-fs (docs.rs)](https://docs.rs/jotta-fs/latest/jotta_fs/) — allocate / chunk upload quirks

### Historical

- Forum API mentions (dead/archived): cited via JaFS — `http://forum.jotta.no/jotta/topics/api_http`; [archived write-support thread](https://web.archive.org/web/20160306095137/http://forum.jotta.no/jotta/topics/jotta_api_for_remote_storage_fetch)
- [Duplicati Jottacloud backend PR](https://github.com/duplicati/duplicati/pull/2355)

### Explicit non-findings

- No official developer portal or OpenAPI/Swagger for JFS / `files/v1` found.
- No verified public file-search REST endpoint found in open-source clients reviewed for this report.
