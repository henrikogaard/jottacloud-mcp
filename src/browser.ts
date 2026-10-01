import type { AppConfig } from "./config.js";
import type { JottaClient } from "./jotta/client.js";
import { assertAllowedPath } from "./jotta/paths.js";
import type { JfsEntry } from "./jotta/xml.js";
import { readFilePayload } from "./read-file.js";

export type BrowserEntry = Pick<
  JfsEntry,
  "kind" | "name" | "path" | "size" | "mime" | "modified"
> & { uri: string };
export type BrowserPage = {
  roots: string[];
  path: string;
  entries: BrowserEntry[];
  count: number;
  nextCursor?: string;
  query?: string;
  truncated: boolean;
};
export type FilePreview = {
  entry: BrowserEntry;
  kind: "text" | "image" | "unsupported";
  content?: string;
  mime?: string;
  truncated: boolean;
};
export function fileUri(path: string): string {
  return `jotta://${path.split("/").map(encodeURIComponent).join("/")}`;
}
export class FileBrowser {
  constructor(
    private readonly client: Pick<
      JottaClient,
      "getNode" | "liststream" | "readBytes" | "extraRootsFor"
    >,
    private readonly config: AppConfig,
  ) {}
  private path(input: string) {
    return assertAllowedPath(input, this.config.roots);
  }
  private entry(item: JfsEntry): BrowserEntry {
    return {
      kind: item.kind,
      name: item.name,
      path: this.path(item.path),
      size: item.size,
      mime: item.mime,
      modified: item.modified,
      uri: fileUri(item.path),
    };
  }
  private allowed(item: JfsEntry, start: string): boolean {
    try {
      const path = this.path(item.path);
      return !item.deleted && (path === start || path.startsWith(`${start}/`));
    } catch {
      return false;
    }
  }
  async list(
    input = this.config.roots[0]!,
    cursor?: string,
  ): Promise<BrowserPage> {
    const path = this.path(input);
    const node = await this.client.getNode(path);
    if (node.kind !== "folder") throw new Error("Choose a folder to browse.");
    const entries = [...node.folders, ...node.files]
      .filter((item) => this.allowed(item, path))
      .map((item) => this.entry(item));
    entries.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
        a.name.localeCompare(b.name),
    );
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0)
      throw new Error("Invalid folder cursor.");
    const end = start + this.config.limits.listDefault;
    return {
      roots: this.config.roots,
      path,
      entries: entries.slice(start, end),
      count: entries.length,
      nextCursor: end < entries.length ? String(end) : undefined,
      truncated: false,
    };
  }
  async search(input: string, query: string): Promise<BrowserPage> {
    const path = this.path(input);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || query.length > 200)
      throw new Error("Enter a file name of 1–200 characters.");
    let entries: JfsEntry[];
    let truncated = false;
    try {
      entries = await this.client.liststream(path);
    } catch {
      entries = [];
      const queue = [path];
      let visits = 0;
      while (queue.length && visits < this.config.limits.searchMaxVisits) {
        const current = queue.shift()!;
        visits++;
        const node = await this.client.getNode(current);
        if (node.kind !== "folder") continue;
        const children = [...node.folders, ...node.files].filter((item) =>
          this.allowed(item, path),
        );
        entries.push(...children);
        queue.push(
          ...children
            .filter((item) => item.kind === "folder")
            .map((item) => item.path),
        );
        if (
          entries.filter((item) =>
            item.name.toLocaleLowerCase().includes(needle),
          ).length >= this.config.limits.searchMaxMatches
        )
          break;
      }
      truncated = queue.length > 0;
    }
    const matches = entries.filter(
      (item) =>
        this.allowed(item, path) &&
        item.name.toLocaleLowerCase().includes(needle),
    );
    return {
      roots: this.config.roots,
      path,
      entries: matches
        .slice(0, this.config.limits.searchMaxMatches)
        .map((item) => this.entry(item)),
      count: Math.min(matches.length, this.config.limits.searchMaxMatches),
      query,
      truncated:
        truncated || matches.length > this.config.limits.searchMaxMatches,
    };
  }
  async preview(input: string): Promise<FilePreview> {
    const path = this.path(input);
    const info = await this.client.getNode(path);
    if (info.kind !== "file") throw new Error("Choose a file to preview.");
    const entry = this.entry(info);
    const image = /^(image\/(png|jpeg|gif|webp))$/.test(info.mime ?? "");
    const text =
      /\.(txt|md|markdown|csv|json|xml|log|ya?ml|toml)$/i.test(info.name) ||
      /^(text\/|application\/(json|xml))/.test(info.mime ?? "");
    if (!text && !image)
      return { entry, kind: "unsupported", truncated: false };
    const payload = await readFilePayload(this.client, this.config, path, {
      max_bytes: image ? this.config.limits.readMaxBytes : 64 * 1024,
    });
    if (image && payload.truncated)
      return { entry, kind: "unsupported", truncated: true };
    if (image && payload.encoding === "base64")
      return {
        entry,
        kind: "image",
        mime: info.mime,
        content: payload.content,
        truncated: false,
      };
    if (text && payload.encoding === "utf8")
      return {
        entry,
        kind: "text",
        mime: payload.mime,
        content: payload.content,
        truncated: payload.truncated,
      };
    return { entry, kind: "unsupported", truncated: payload.truncated };
  }
}
