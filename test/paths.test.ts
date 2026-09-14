import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowedPath, mapAgentPath, normalizeAgentPath, PathError } from "../src/jotta/paths.ts";

describe("normalizeAgentPath", () => {
  it("collapses dots and duplicate slashes", () => {
    assert.equal(normalizeAgentPath("/Archive/./docs//a.md"), "/Archive/docs/a.md");
  });

  it("rejects relative paths", () => {
    assert.throws(() => normalizeAgentPath("Archive/docs"), PathError);
  });

  it("rejects escaping the root", () => {
    assert.throws(() => normalizeAgentPath("/Archive/../.."), PathError);
  });
});

describe("assertAllowedPath", () => {
  it("allows paths under a configured root", () => {
    assert.equal(assertAllowedPath("/Archive/docs/a.md", ["/Archive"]), "/Archive/docs/a.md");
  });

  it("rejects other mountpoints", () => {
    assert.throws(() => assertAllowedPath("/Sync/photos", ["/Archive"]), PathError);
  });

  it("rejects sibling escape via ..", () => {
    assert.throws(() => assertAllowedPath("/Archive/../Sync", ["/Archive"]), PathError);
  });
});

describe("mapAgentPath", () => {
  it("maps /Archive files onto JFS and allocate paths", () => {
    const mapped = mapAgentPath("/Archive/docs/a.md", ["/Archive"], "user1", "Jotta");
    assert.equal(mapped.jfsRelative, "user1/Jotta/Archive/docs/a.md");
    assert.equal(mapped.allocatePath, "/jfs/Jotta/Archive/docs/a.md");
    assert.equal(mapped.moveDest, "/user1/Jotta/Archive/docs/a.md");
  });

  it("maps trash when /Trash is an extra root", () => {
    const mapped = mapAgentPath("/Trash/note.md", ["/Archive", "/Trash"], "user1", "Jotta");
    assert.equal(mapped.jfsRelative, "user1/Jotta/Trash/note.md");
  });
});
