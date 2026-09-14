import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeLoginToken } from "../src/auth/login-token.ts";

describe("decodeLoginToken", () => {
  it("decodes base64url JSON from the web UI", () => {
    const payload = Buffer.from(
      JSON.stringify({
        username: "abc123",
        realm: "jottacloud",
        well_known_link: "https://id.jottacloud.com/auth/realms/jottacloud/.well-known/openid-configuration",
        auth_token: "secret-value",
      }),
      "utf8",
    ).toString("base64url");
    const token = decodeLoginToken(payload);
    assert.equal(token.username, "abc123");
    assert.equal(token.auth_token, "secret-value");
  });
});
