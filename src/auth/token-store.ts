import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  username?: string;
};

export class TokenStore {
  constructor(private readonly path: string) {}

  async read(): Promise<StoredTokens | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoredTokens;
      if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_at) {
        return undefined;
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(tokens, null, 2)}\n`;
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await acquireLock(lockPath);
    try {
      await handle.writeFile(String(process.pid), { encoding: "utf8" });
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function acquireLock(lockPath: string) {
  try {
    return await open(lockPath, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isFinite(pid) && !pidAlive(pid)) {
      await unlink(lockPath).catch(() => undefined);
      return open(lockPath, "wx");
    }
    throw new Error(
      `Token store is locked (${lockPath}). Another jottacloud-mcp process may be using this refresh token; sharing one store across processes will revoke the session.`,
    );
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
