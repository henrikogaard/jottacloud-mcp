import { XMLParser } from "fast-xml-parser";

export type JfsKind = "file" | "folder";

export type JfsEntry = {
  kind: JfsKind;
  name: string;
  path: string;
  size?: number;
  mime?: string;
  md5?: string;
  modified?: string;
  created?: string;
  state?: string;
  uuid?: string;
  deleted?: boolean;
  publicURI?: string;
  publicSharePath?: string;
  shareUrl?: string;
};

export type JfsListing = {
  kind: "folder";
  name: string;
  path: string;
  folders: JfsEntry[];
  files: JfsEntry[];
};

export type JfsFile = JfsEntry & { kind: "file" };
export type JfsNode = JfsListing | JfsFile;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: Record<string, unknown>, key: string): string | undefined {
  const direct = node[key];
  if (typeof direct === "string") return direct;
  const prefixed = node[`@_${key}`];
  return typeof prefixed === "string" ? prefixed : undefined;
}

function text(node: unknown): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && "#text" in node) {
    const value = (node as { "#text"?: unknown })["#text"];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

function stripUserDevice(jfsPath: string): string {
  const cleaned = jfsPath.startsWith("/") ? jfsPath : `/${jfsPath}`;
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `/${parts.slice(2).join("/")}`;
  }
  return cleaned;
}

function mapFile(raw: Record<string, unknown>, folderPath?: string): JfsFile {
  const name = attr(raw, "name") ?? "unknown";
  const rev = (raw.currentRevision ?? {}) as Record<string, unknown>;
  const parent = folderPath ?? stripUserDevice(text(raw.path) ?? "");
  const path = parent.endsWith(`/${name}`) || parent === `/${name}` || parent === name
    ? (parent.startsWith("/") ? parent : `/${parent}`)
    : `${parent === "/" ? "" : parent}/${name}`.replace(/\/+/g, "/").replace(/^([^/])/, "/$1");
  return {
    kind: "file",
    name,
    path: path.startsWith("/") ? path : `/${path}`,
    uuid: attr(raw, "uuid"),
    size: numberish(text(rev.size) ?? text(raw.size)),
    mime: text(rev.mime) ?? text(raw.mime),
    md5: text(rev.md5) ?? text(raw.md5),
    modified: text(rev.modified) ?? text(raw.modified),
    created: text(rev.created) ?? text(raw.created),
    state: text(rev.state) ?? text(raw.state),
    deleted: attr(raw, "deleted") != null,
    publicURI: text(raw.publicURI) ?? attr(raw, "publicURI"),
    publicSharePath: text(raw.publicSharePath) ?? attr(raw, "publicSharePath"),
  };
}

export function publicDownloadUrl(username: string, publicURI: string): string {
  const cleaned = publicURI.replace(/^\/+/, "");
  return `https://www.jottacloud.com/opin/io/downloadPublic/${encodeURIComponent(username)}/${cleaned}`;
}

function attachShareUrl(entry: JfsEntry, username: string): JfsEntry {
  if (!entry.publicURI) return entry;
  return { ...entry, shareUrl: publicDownloadUrl(username, entry.publicURI) };
}

export function withShareUrls<T extends JfsNode | JfsEntry>(node: T, username: string): T {
  if ("kind" in node && node.kind === "folder" && "files" in node) {
    const folder = node as JfsListing;
    return {
      ...folder,
      files: folder.files.map((f) => attachShareUrl(f, username)),
      folders: folder.folders.map((f) => attachShareUrl(f, username)),
    } as T;
  }
  return attachShareUrl(node as JfsEntry, username) as T;
}

function throwIfJfsError(data: Record<string, unknown>): void {
  if (!data.error) return;
  const err = data.error as Record<string, unknown>;
  const message = text(err.message) ?? "Jottacloud error";
  const code = text(err.code) ?? "";
  throw new Error(`Jottacloud error ${code}: ${message}`);
}

/** Convert JFS or liststream path text into an agent path (`/Archive/...`). */
export function toAgentPath(rawPath: string, filename?: string): string {
  let p = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const parts = p.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[1]?.toLowerCase() === "jotta") {
    p = `/${parts.slice(2).join("/")}`;
  }
  if (filename && !p.endsWith(`/${filename}`) && p !== `/${filename}`) {
    p = `${p === "/" ? "" : p}/${filename}`;
  }
  p = p.replace(/\/+/g, "/");
  return p.startsWith("/") ? p : `/${p}`;
}

function mapListstreamFile(raw: Record<string, unknown>): JfsEntry {
  const filename = text(raw.filename) ?? attr(raw, "name") ?? "unknown";
  const folder = text(raw.path) ?? "";
  const path = toAgentPath(folder, filename);
  return {
    kind: "file",
    name: filename,
    path,
    size: numberish(text(raw.size)),
    md5: text(raw.md5),
    mime: text(raw.mime),
    modified: text(raw.modified),
    created: text(raw.created),
    state: text(raw.state),
    uuid: attr(raw, "uuid"),
    deleted: attr(raw, "deleted") != null,
  };
}

function mapListstreamFolder(raw: Record<string, unknown>): JfsEntry {
  const name = text(raw.name) ?? attr(raw, "name") ?? "folder";
  const folder = text(raw.path) ?? "";
  return {
    kind: "folder",
    name,
    path: toAgentPath(folder, name),
    deleted: attr(raw, "deleted") != null,
  };
}

/**
 * Parse rclone-style `?mode=liststream` XML (concatenated `<file>`/`<folder>`
 * elements, optionally wrapped). Paths are mount-relative (`/Archive/...`).
 */
export function parseListstreamXml(xmlText: string): JfsEntry[] {
  const stripped = xmlText.replace(/^\uFEFF/, "").trim();
  if (!stripped) return [];
  const inner = stripped.replace(/^<\?xml[^?]*\?>/i, "").trim();
  const wrapped = `<liststream>${inner}</liststream>`;
  const data = parser.parse(wrapped) as Record<string, unknown>;
  throwIfJfsError(data);

  const root = (data.liststream ?? data) as Record<string, unknown>;
  throwIfJfsError(root);

  const files = asArray(root.file).map((item) => mapListstreamFile(item as Record<string, unknown>));
  const folders = asArray(root.folder).map((item) => mapListstreamFolder(item as Record<string, unknown>));
  return [...folders, ...files];
}

export function parseMountPoints(xmlText: string): string[] {
  const data = parser.parse(xmlText) as Record<string, unknown>;
  throwIfJfsError(data);

  const devices = [
    ...asArray(data.device),
    ...asArray((data.user as { devices?: { device?: unknown } } | undefined)?.devices?.device),
    ...asArray((data.drive as { devices?: { device?: unknown } } | undefined)?.devices?.device),
  ];

  const mounts: string[] = [];
  const seen = new Set<string>();

  const collect = (node: Record<string, unknown> | undefined): void => {
    if (!node) return;
    const points = asArray((node.mountPoints as { mountPoint?: unknown } | undefined)?.mountPoint);
    for (const item of points) {
      const mp = item as Record<string, unknown>;
      const name = attr(mp, "name") ?? text(mp.name);
      if (!name) continue;
      const path = name.startsWith("/") ? name : `/${name}`;
      if (seen.has(path)) continue;
      seen.add(path);
      mounts.push(path);
    }
  };

  if (data.mountPoint) {
    collect({ mountPoints: { mountPoint: data.mountPoint } });
  }
  for (const device of devices) {
    collect(device as Record<string, unknown>);
  }
  if (mounts.length === 0 && data.mountPoints) {
    collect(data);
  }
  return mounts;
}

function numberish(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseJfsXml(xmlText: string): JfsNode {
  const data = parser.parse(xmlText) as Record<string, unknown>;
  throwIfJfsError(data);

  if (data.file && !data.folder && !data.mountPoint) {
    const fileNode = data.file as Record<string, unknown>;
    return mapFile(fileNode, stripUserDevice(text(fileNode.path) ?? ""));
  }

  const root = (data.mountPoint ?? data.folder) as Record<string, unknown> | undefined;
  if (!root) {
    throw new Error("Unexpected JFS XML (neither file, folder, nor mountPoint)");
  }

  const name = attr(root, "name") ?? text(root.name) ?? "root";
  const folderPath = stripUserDevice(text(root.path) ?? "") || `/${name}`;
  const selfPath = folderPath.endsWith(`/${name}`) || folderPath === `/${name}` ? folderPath : `${folderPath === "/" ? "" : folderPath}/${name}`;

  const folders = asArray((root.folders as { folder?: unknown } | undefined)?.folder).map((item) => {
    const f = item as Record<string, unknown>;
    const fname = attr(f, "name") ?? "folder";
    return {
      kind: "folder" as const,
      name: fname,
      path: `${selfPath}/${fname}`.replace(/\/+/g, "/"),
      deleted: attr(f, "deleted") != null,
    };
  });

  const files = asArray((root.files as { file?: unknown } | undefined)?.file).map((item) =>
    mapFile(item as Record<string, unknown>, selfPath),
  );

  return {
    kind: "folder",
    name,
    path: selfPath.startsWith("/") ? selfPath : `/${selfPath}`,
    folders,
    files,
  };
}
