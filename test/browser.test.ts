import assert from "node:assert/strict";
import { it } from "node:test";
import { FileBrowser, fileUri } from "../src/browser.ts";
import { loadConfig } from "../src/config.ts";
import type { JottaClient } from "../src/jotta/client.ts";
import type { JfsNode, JfsEntry } from "../src/jotta/xml.ts";
const config = {
  ...loadConfig(),
  roots: ["/Sync/Documents"],
  limits: { ...loadConfig().limits, listDefault: 2, searchMaxVisits: 1 },
};
const file: JfsEntry = {
  kind: "file",
  name: "note.md",
  path: "/Sync/Documents/note.md",
  mime: "text/markdown",
  size: 5,
  shareUrl: "https://private.example/secret",
};
function fixture() {
  let reads = 0;
  const client: Pick<
    JottaClient,
    "getNode" | "liststream" | "readBytes" | "extraRootsFor"
  > = {
    getNode: async (path): Promise<JfsNode> =>
      path.endsWith("note.md")
        ? { ...file, kind: "file" }
        : {
            kind: "folder",
            name: "Documents",
            path,
            folders: [
              {
                kind: "folder",
                name: "folder",
                path: "/Sync/Documents/folder",
              },
            ],
            files: [
              file,
              { ...file, name: "z.md", path: "/Sync/Documents/z.md" },
              { ...file, path: "/Sync/Private/secret.md" },
            ],
          },
    liststream: async () => [
      file,
      { ...file, path: "/Sync/Private/note.md" },
      { ...file, deleted: true },
    ],
    extraRootsFor: () => [],
    readBytes: async () => {
      reads++;
      return { bytes: Buffer.from("hello"), mime: "text/plain" };
    },
  };
  return {
    client,
    browser: new FileBrowser(client, config),
    reads: () => reads,
  };
}
it("rejects scope escapes before reading the remote account", async () => {
  const { browser } = fixture();
  await assert.rejects(() => browser.list("/Sync/Private"));
  await assert.rejects(() =>
    browser.preview("/Sync/Documents/../../Private/note.md"),
  );
});
it("filters out-of-scope metadata, sorts folders first and paginates", async () => {
  const { browser } = fixture();
  const first = await browser.list();
  assert.equal(first.count, 3);
  assert.equal(first.entries[0].kind, "folder");
  assert.equal(first.nextCursor, "2");
  assert.equal("shareUrl" in first.entries[1], false);
  const second = await browser.list(undefined, first.nextCursor);
  assert.deepEqual(
    second.entries.map((e) => e.name),
    ["z.md"],
  );
  await assert.rejects(() => browser.list(undefined, "NaN"));
});
it("name search does not leak out-of-scope or deleted results", async () => {
  const { browser } = fixture();
  const result = await browser.search("/Sync/Documents", "NOTE");
  assert.equal(result.count, 1);
  assert.equal(result.entries[0].path, file.path);
});
it("fallback search reports an incomplete walk", async () => {
  const { browser, client } = fixture();
  client.liststream = async () => {
    throw new Error("Unavailable");
  };
  const result = await browser.search("/Sync/Documents", "note");
  assert.equal(result.truncated, true);
});
it("reads supported text but keeps unsupported files metadata-only", async () => {
  const { browser, client, reads } = fixture();
  assert.equal((await browser.preview(file.path)).content, "hello");
  assert.equal(reads(), 1);
  client.getNode = async () => ({
    ...file,
    kind: "file",
    name: "document.pdf",
    path: "/Sync/Documents/document.pdf",
    mime: "application/pdf",
  });
  assert.equal(
    (await browser.preview("/Sync/Documents/document.pdf")).kind,
    "unsupported",
  );
  assert.equal(reads(), 1);
});
it("encodes filenames in resource URIs", () =>
  assert.equal(fileUri("/Sync/a #?.txt"), "jotta:///Sync/a%20%23%3F.txt"));
