import {
  McpServer,
  ResourceTemplate,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import { askLoginToken, envLoginHint } from "./login.js";
import { PathError, TRASH_ROOT } from "./jotta/paths.js";
import type { JottaClient } from "./jotta/client.js";
import type { JfsEntry } from "./jotta/xml.js";
import { registerBrowser } from "./browser-tools.js";
import { readFilePayload } from "./read-file.js";

const openWorld = { openWorldHint: true } as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function paginate<T>(items: T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor?: string } {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  const offset = Number.isFinite(start) && start > 0 ? start : 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, nextCursor: next < items.length ? String(next) : undefined };
}

async function searchByWalk(
  client: JottaClient,
  config: AppConfig,
  start: string,
  needle: string,
  extraRoots: string[],
): Promise<{ matches: JfsEntry[]; truncated: boolean }> {
  const matches: JfsEntry[] = [];
  let visits = 0;
  const queue = [start];
  while (queue.length && visits < config.limits.searchMaxVisits && matches.length < config.limits.searchMaxMatches) {
    const current = queue.shift()!;
    visits += 1;
    const node = await client.getNode(current, extraRoots);
    if (node.kind === "file") {
      if (node.name.toLowerCase().includes(needle)) matches.push(node);
      continue;
    }
    for (const entry of [...node.folders, ...node.files]) {
      if (entry.name.toLowerCase().includes(needle)) matches.push(entry);
      if (entry.kind === "folder") queue.push(entry.path);
    }
  }
  return {
    matches,
    truncated: visits >= config.limits.searchMaxVisits || matches.length >= config.limits.searchMaxMatches,
  };
}

async function replaceIfNeeded(
  client: JottaClient,
  dest: string,
  overwrite: boolean | undefined,
): Promise<ReturnType<typeof fail> | undefined> {
  let destExists = false;
  try {
    await client.getNode(dest);
    destExists = true;
  } catch {
    destExists = false;
  }
  if (destExists && !overwrite) {
    return fail("Destination exists. Pass overwrite=true to replace it (destination is soft-deleted first).");
  }
  if (destExists && overwrite) {
    const destNode = await client.getNode(dest);
    await client.softDelete(dest, destNode.kind === "folder" ? "folder" : "file");
  }
  return undefined;
}

export function registerTools(server: McpServer, client: JottaClient, config: AppConfig): void {
  server.registerTool(
    "login",
    {
      description:
        "Sign in with a Jottacloud personal login token. The host should prompt privately (elicitation). Do not paste the token into chat.",
      inputSchema: z.object({}),
      annotations: { ...openWorld },
    },
    async (_args, ctx: ServerContext) => {
      try {
        if (await client.hasSession()) {
          return ok({ loggedIn: true, username: client.getUsername(), source: "existing_session" });
        }
        const asked = await askLoginToken(ctx);
        if ("inputRequired" in asked) return asked.inputRequired;
        if ("error" in asked) return fail(asked.error);
        await client.loginWithPersonalToken(asked.token);
        return ok({ loggedIn: true, username: client.getUsername(), source: "elicitation" });
      } catch (err) {
        return fail(err instanceof Error ? `${err.message}. ${envLoginHint}` : err);
      }
    },
  );

  server.registerTool(
    "list_roots",
    {
      description:
        "List configured Jottacloud path roots this server may access, plus discovered mounts when logged in. Trash is not a default search root.",
      inputSchema: z.object({}),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async () => {
      try {
        const mounts = (await client.hasSession()) ? await client.listMounts().catch(() => []) : [];
        return ok({
          roots: config.roots,
          device: config.device,
          readOnly: config.readOnly,
          mounts,
          trash: TRASH_ROOT,
          hint: "Add Sync with JOTTACLOUD_ROOTS=/Archive,/Sync. Trash is only used by list_trash / restore_file.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_directory",
    {
      description: "List files and folders at a Jottacloud path (e.g. /Archive or /Archive/docs).",
      inputSchema: z.object({
        path: z.string().describe("Absolute path under a configured root, e.g. /Archive"),
        limit: z.number().int().min(1).max(config.limits.listMax).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async ({ path, limit, cursor }) => {
      try {
        const extra = client.extraRootsFor(path);
        const node = await client.getNode(path, extra);
        if (node.kind !== "folder") {
          return fail(`${path} is a file, not a directory`);
        }
        const entries = [...node.folders, ...node.files];
        const page = paginate(entries, cursor, limit ?? config.limits.listDefault);
        return ok({
          path: node.path,
          count: entries.length,
          entries: page.items,
          nextCursor: page.nextCursor,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_file_info",
    {
      description: "Get metadata for a Jottacloud file or folder. Does not download content.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, e.g. /Archive/docs/note.md"),
      }),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async ({ path }) => {
      try {
        return ok(await client.getNode(path, client.extraRootsFor(path)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_files",
    {
      description:
        "Search file and folder names under a path. Uses Jottacloud liststream when possible, then a capped folder walk.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Case-insensitive substring to match against names"),
        path: z.string().optional().describe("Start path; defaults to the first configured root"),
      }),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async ({ query, path }) => {
      try {
        const start = path ?? config.roots[0]!;
        const extra = client.extraRootsFor(start);
        const needle = query.toLowerCase();
        let method: "liststream" | "walk" = "liststream";
        let truncated = false;
        let matches: JfsEntry[] = [];
        try {
          const entries = await client.liststream(start, extra);
          matches = entries.filter((entry) => entry.name.toLowerCase().includes(needle));
          truncated = matches.length > config.limits.searchMaxMatches;
          matches = matches.slice(0, config.limits.searchMaxMatches);
        } catch {
          method = "walk";
          const walked = await searchByWalk(client, config, start, needle, extra);
          matches = walked.matches;
          truncated = walked.truncated;
        }
        return ok({ query, path: start, method, truncated, matches });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a file from Jottacloud. Text is returned as UTF-8 (capped); binary as base64. Use head/tail/max_bytes to stay small.",
      inputSchema: z.object({
        path: z.string(),
        max_bytes: z.number().int().min(1).optional(),
        head: z.number().int().min(1).optional(),
        tail: z.number().int().min(1).optional(),
      }),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async ({ path, max_bytes, head, tail }) => {
      try {
        return ok(await readFilePayload(client, config, path, { max_bytes, head, tail }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_trash",
    {
      description: "List items in Jottacloud trash (~30 days). Trash is not included in default roots or search.",
      inputSchema: z.object({
        path: z.string().optional().describe("Trash path; defaults to /Trash"),
        limit: z.number().int().min(1).max(config.limits.listMax).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { ...openWorld, readOnlyHint: true },
    },
    async ({ path, limit, cursor }) => {
      try {
        const start = path ?? TRASH_ROOT;
        if (start !== TRASH_ROOT && !start.startsWith(`${TRASH_ROOT}/`)) {
          return fail(`list_trash only accepts paths under ${TRASH_ROOT}`);
        }
        const node = await client.getNode(start, [TRASH_ROOT]);
        if (node.kind !== "folder") {
          return fail(`${start} is a file, not a directory`);
        }
        const entries = [...node.folders, ...node.files];
        const page = paginate(entries, cursor, limit ?? config.limits.listDefault);
        return ok({
          path: node.path,
          count: entries.length,
          entries: page.items,
          nextCursor: page.nextCursor,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (config.readOnly) return;

  server.registerTool(
    "write_file",
    {
      description:
        "Create or overwrite a file. Provide utf8 text or base64. Overwrite requires overwrite=true. Size is capped.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        overwrite: z.boolean().optional(),
      }),
      annotations: { ...openWorld, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, content, encoding, overwrite }) => {
      try {
        const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
        if (bytes.length > config.limits.writeMaxBytes) {
          return fail(`File too large for MCP write (${bytes.length} > ${config.limits.writeMaxBytes} bytes)`);
        }
        let existed = false;
        try {
          const node = await client.getNode(path);
          existed = node.kind === "file";
          if (node.kind === "folder") return fail(`${path} is a directory`);
        } catch (err) {
          if (err instanceof PathError) return fail(err);
        }
        if (existed && !overwrite) {
          return fail("File exists. Pass overwrite=true to replace it.");
        }
        const parent = path.replace(/\/[^/]+$/, "") || "/";
        await client.mkdirParents(parent);
        const result = await client.writeFile(path, bytes);
        return ok({ path, bytes: bytes.length, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_directory",
    {
      description: "Create a directory (and parents) at a Jottacloud path. Idempotent if it already exists.",
      inputSchema: z.object({
        path: z.string(),
      }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ path }) => {
      try {
        await client.mkdirParents(path);
        return ok({ path, created: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "copy_file",
    {
      description: "Copy a file or directory to a new path. Fails if destination exists unless overwrite=true.",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
        overwrite: z.boolean().optional(),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ from, to, overwrite }) => {
      try {
        const blocked = await replaceIfNeeded(client, to, overwrite);
        if (blocked) return blocked;
        const parent = to.replace(/\/[^/]+$/, "") || "/";
        if (parent !== "/") await client.mkdirParents(parent);
        await client.copy(from, to, client.extraRootsFor(from));
        return ok({ from, to, copied: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "move_file",
    {
      description: "Move or rename a file or directory. Fails if destination exists unless overwrite=true.",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
        overwrite: z.boolean().optional(),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ from, to, overwrite }) => {
      try {
        const blocked = await replaceIfNeeded(client, to, overwrite);
        if (blocked) return blocked;
        const parent = to.replace(/\/[^/]+$/, "") || "/";
        if (parent !== "/") await client.mkdirParents(parent);
        await client.move(from, to, client.extraRootsFor(from));
        return ok({ from, to });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "restore_file",
    {
      description: "Restore a file or folder from /Trash into an allowed root (move). Fails if destination exists unless overwrite=true.",
      inputSchema: z.object({
        from: z.string().describe("Path under /Trash"),
        to: z.string().describe("Destination under a configured root, e.g. /Archive/docs/note.md"),
        overwrite: z.boolean().optional(),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ from, to, overwrite }) => {
      try {
        if (from !== TRASH_ROOT && !from.startsWith(`${TRASH_ROOT}/`)) {
          return fail(`restore_file source must be under ${TRASH_ROOT}`);
        }
        const blocked = await replaceIfNeeded(client, to, overwrite);
        if (blocked) return blocked;
        const parent = to.replace(/\/[^/]+$/, "") || "/";
        if (parent !== "/") await client.mkdirParents(parent);
        await client.move(from, to, [TRASH_ROOT]);
        return ok({ from, to, restored: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      description:
        "Soft-delete a file or folder to Jottacloud trash (~30 days). Requires confirm=true. Hard delete is not supported.",
      inputSchema: z.object({
        path: z.string(),
        confirm: z.boolean(),
      }),
      annotations: { ...openWorld, destructiveHint: true },
    },
    async ({ path, confirm }) => {
      try {
        if (confirm !== true) {
          return fail("Refusing to delete without confirm=true (soft-delete to trash).");
        }
        const extra = client.extraRootsFor(path);
        const node = await client.getNode(path, extra);
        await client.softDelete(path, node.kind === "folder" ? "folder" : "file", extra);
        return ok({ path, deleted: true, mode: "trash" });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_share_link",
    {
      description: "Enable a public share on a file and return the download URL (Jottacloud enableShare).",
      inputSchema: z.object({
        path: z.string(),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ path }) => {
      try {
        const node = await client.setShare(path, true);
        return ok(node);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "revoke_share_link",
    {
      description: "Disable a public share on a file (Jottacloud disableShare).",
      inputSchema: z.object({
        path: z.string(),
      }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ path }) => {
      try {
        const node = await client.setShare(path, false);
        return ok({ ...node, revoked: true });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export function registerResources(server: McpServer, client: JottaClient, config: AppConfig): void {
  server.registerResource(
    "jotta-file",
    new ResourceTemplate("jotta:///{+path}", { list: undefined }),
    {
      title: "Jottacloud file",
      description:
        "Read a file under a configured root. URI form: jotta:///Archive/docs/note.md (same caps as read_file).",
      mimeType: "application/octet-stream",
    },
    async (uri, variables) => {
      const raw = typeof variables.path === "string" ? variables.path : uri.pathname.replace(/^\/+/, "");
      const path = raw.startsWith("/") ? raw : `/${raw}`;
      try {
        const payload = await readFilePayload(client, config, path);
        if (payload.encoding === "utf8") {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: payload.mime ?? "text/plain",
                text: payload.content,
              },
            ],
          };
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: payload.mime ?? "application/octet-stream",
              blob: payload.content,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }
    },
  );
}

export function createJottaMcpServer(client: JottaClient, config: AppConfig): McpServer {
  const server = new McpServer({
    name: "jottacloud-mcp",
    version: "0.1.0",
  });
  registerTools(server, client, config);
  registerResources(server, client, config);
  registerBrowser(server, client, config);
  return server;
}
