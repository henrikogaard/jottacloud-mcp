export type LoginToken = {
  username: string;
  realm?: string;
  well_known_link: string;
  auth_token: string;
};

export function decodeLoginToken(raw: string): LoginToken {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Personal login token is empty");
  }
  const jsonText = decodeBase64Flexible(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Personal login token is not valid JSON after base64url decode");
  }
  if (!isRecord(parsed)) {
    throw new Error("Personal login token JSON must be an object");
  }
  const username = requiredString(parsed, "username");
  const auth_token = requiredString(parsed, "auth_token");
  const well_known_link =
    optionalString(parsed, "well_known_link") ??
    "https://id.jottacloud.com/auth/realms/jottacloud/.well-known/openid-configuration";
  return {
    username,
    realm: optionalString(parsed, "realm"),
    well_known_link,
    auth_token,
  };
}

function decodeBase64Flexible(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(value, "base64url");
  if (buf.length > 0) {
    const asText = buf.toString("utf8");
    if (asText.startsWith("{")) return asText;
  }
  const classic = Buffer.from(padded, "base64");
  const classicText = classic.toString("utf8");
  if (classicText.startsWith("{")) return classicText;
  throw new Error("Personal login token is not valid base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Personal login token missing ${key}`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
