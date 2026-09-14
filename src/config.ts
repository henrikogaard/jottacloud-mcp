import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  loginToken?: string;
  tokenStorePath: string;
  roots: string[];
  readOnly: boolean;
  device: string;
  defaultMount: string;
  limits: {
    listDefault: number;
    listMax: number;
    readMaxBytes: number;
    writeMaxBytes: number;
    searchMaxVisits: number;
    searchMaxMatches: number;
    searchListstreamMaxBytes: number;
  };
};

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function defaultTokenStore(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "jottacloud-mcp", "tokens.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "jottacloud-mcp", "tokens.json");
}

export function loadConfig(): AppConfig {
  const rootsRaw = csv(process.env.JOTTACLOUD_ROOTS);
  const roots = (rootsRaw.length ? rootsRaw : ["/Archive"]).map((root) =>
    root.startsWith("/") ? root.replace(/\/+$/, "") || "/" : `/${root.replace(/\/+$/, "")}`,
  );

  return {
    loginToken: process.env.JOTTACLOUD_LOGIN_TOKEN || undefined,
    tokenStorePath: process.env.JOTTACLOUD_TOKEN_STORE ?? defaultTokenStore(),
    roots,
    readOnly: truthy(process.env.JOTTACLOUD_READ_ONLY) || !process.env.JOTTACLOUD_READ_ONLY,
    device: process.env.JOTTACLOUD_DEVICE ?? "Jotta",
    defaultMount: process.env.JOTTACLOUD_MOUNT ?? "Archive",
    limits: {
      listDefault: 100,
      listMax: 500,
      readMaxBytes: 512 * 1024,
      writeMaxBytes: 4 * 1024 * 1024,
      searchMaxVisits: 200,
      searchMaxMatches: 100,
      searchListstreamMaxBytes: 8 * 1024 * 1024,
    },
  };
}
