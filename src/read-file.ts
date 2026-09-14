import type { AppConfig } from "./config.js";
import type { JottaClient } from "./jotta/client.js";

export type ReadFilePayload = {
  path: string;
  mime?: string;
  size: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
  content: string;
};

export function looksText(mime: string | undefined, bytes: Buffer): boolean {
  if (mime?.startsWith("text/") || mime?.includes("json") || mime?.includes("xml") || mime?.includes("javascript")) {
    return true;
  }
  const sample = bytes.subarray(0, 1024);
  if (sample.includes(0)) return false;
  try {
    sample.toString("utf8");
    return true;
  } catch {
    return false;
  }
}

export async function readFilePayload(
  client: JottaClient,
  config: AppConfig,
  path: string,
  opts: { max_bytes?: number; head?: number; tail?: number } = {},
): Promise<ReadFilePayload> {
  const extra = client.extraRootsFor(path);
  const info = await client.getNode(path, extra);
  if (info.kind !== "file") {
    throw new Error(`${path} is a directory`);
  }
  const cap = Math.min(opts.max_bytes ?? config.limits.readMaxBytes, config.limits.readMaxBytes);
  const size = info.size ?? 0;
  let range: { start: number; end: number } | undefined;
  if (opts.tail && size > 0) {
    const start = Math.max(0, size - Math.min(opts.tail, cap));
    range = { start, end: size - 1 };
  } else if (opts.head) {
    range = { start: 0, end: Math.min(opts.head, cap) - 1 };
  } else if (size > cap) {
    range = { start: 0, end: cap - 1 };
  }
  const { bytes, mime } = await client.readBytes(path, range, extra);
  const truncated = size > bytes.length;
  const textMode = looksText(info.mime ?? mime, bytes);
  return {
    path,
    mime: info.mime ?? mime,
    size,
    truncated,
    encoding: textMode ? "utf8" : "base64",
    content: textMode ? bytes.toString("utf8") : bytes.toString("base64"),
  };
}
