export const TRASH_ROOT = "/Trash";

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

export function normalizeAgentPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathError("Path is required");
  }
  if (!input.startsWith("/")) {
    throw new PathError("Path must be absolute (start with /)");
  }
  const parts = input.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        throw new PathError("Path escapes the drive root");
      }
      out.pop();
      continue;
    }
    if (part.includes("\0")) {
      throw new PathError("Path contains invalid characters");
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

export function assertAllowedPath(input: string, roots: string[]): string {
  const normalized = normalizeAgentPath(input);
  const allowed = roots.some((root) => {
    const r = normalizeAgentPath(root);
    return nEqualsOrUnder(normalized, r);
  });
  if (!allowed) {
    throw new PathError(`Path is outside allowed roots (${roots.join(", ")}): ${normalized}`);
  }
  return normalized;
}

function nEqualsOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export type JfsMapping = {
  agentPath: string;
  mount: string;
  restSegments: string[];
  /** Path relative to JFS root URL: {user}/{device}/{mount}/... (unencoded) */
  jfsRelative: string;
  /** Allocate API path: /jfs/{device}/{mount}/... */
  allocatePath: string;
  /** Move destination: /{user}/{device}/{mount}/... */
  moveDest: string;
};

export function mapAgentPath(
  input: string,
  roots: string[],
  username: string,
  device: string,
): JfsMapping {
  const agentPath = assertAllowedPath(input, roots);
  const segments = agentPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new PathError("Path must include a mountpoint (e.g. /Archive)");
  }
  const [mount, ...restSegments] = segments;
  const jfsRelative = [username, device, mount, ...restSegments].join("/");
  const allocatePath = ["", "jfs", device, mount, ...restSegments].join("/");
  const moveDest = `/${jfsRelative}`;
  return { agentPath, mount, restSegments, jfsRelative, allocatePath, moveDest };
}

export function encodeJfsPath(jfsRelative: string): string {
  return jfsRelative
    .split("/")
    .map((seg) => encodeURIComponent(seg).replaceAll("+", "%2B"))
    .join("/");
}

export function agentPathFromJfs(jfsPath: string, username: string, device: string): string {
  const cleaned = jfsPath.startsWith("/") ? jfsPath : `/${jfsPath}`;
  const prefix = `/${username}/${device}`;
  if (cleaned === prefix) return "/";
  if (cleaned.startsWith(`${prefix}/`)) return cleaned.slice(prefix.length);
  return cleaned;
}
