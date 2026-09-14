import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseJfsXml,
  parseListstreamXml,
  parseMountPoints,
  publicDownloadUrl,
  toAgentPath,
  withShareUrls,
} from "../src/jotta/xml.ts";

const folderXml = `<?xml version="1.0" encoding="UTF-8"?>
<folder name="docs">
  <path xml:space="preserve">/user1/Jotta/Archive</path>
  <folders>
    <folder name="sub"/>
  </folders>
  <files>
    <file name="note.md" uuid="11111111-1111-1111-1111-111111111111">
      <currentRevision>
        <number>1</number>
        <state>COMPLETED</state>
        <created>2018-07-05-T15:08:02Z</created>
        <modified>2018-07-05-T15:08:02Z</modified>
        <mime>text/plain</mime>
        <size>12</size>
        <md5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</md5>
      </currentRevision>
    </file>
  </files>
</folder>`;

const fileXml = `<?xml version="1.0" encoding="UTF-8"?>
<file name="note.md" uuid="11111111-1111-1111-1111-111111111111">
  <path xml:space="preserve">/user1/Jotta/Archive/docs</path>
  <currentRevision>
    <state>COMPLETED</state>
    <mime>text/plain</mime>
    <size>12</size>
    <md5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</md5>
    <modified>2018-07-05-T15:08:02Z</modified>
  </currentRevision>
</file>`;

describe("parseJfsXml", () => {
  it("parses a folder listing into agent-style paths", () => {
    const node = parseJfsXml(folderXml);
    assert.equal(node.kind, "folder");
    if (node.kind !== "folder") return;
    assert.equal(node.folders[0]?.name, "sub");
    assert.equal(node.files[0]?.name, "note.md");
    assert.equal(node.files[0]?.path, "/Archive/docs/note.md");
    assert.equal(node.files[0]?.size, 12);
  });

  it("parses a single file", () => {
    const node = parseJfsXml(fileXml);
    assert.equal(node.kind, "file");
    assert.equal(node.name, "note.md");
    assert.equal(node.path, "/Archive/docs/note.md");
    assert.equal(node.mime, "text/plain");
  });

  it("parses enableShare publicURI", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<file name="note.md">
  <path xml:space="preserve">/user1/Jotta/Archive/docs</path>
  <publicURI>abc123public</publicURI>
  <publicSharePath>/user1/abc123public</publicSharePath>
  <currentRevision>
    <state>COMPLETED</state>
    <mime>text/plain</mime>
    <size>12</size>
  </currentRevision>
</file>`;
    const node = withShareUrls(parseJfsXml(xml), "user1");
    assert.equal(node.kind, "file");
    if (node.kind !== "file") return;
    assert.equal(node.publicURI, "abc123public");
    assert.equal(node.shareUrl, "https://www.jottacloud.com/opin/io/downloadPublic/user1/abc123public");
  });
});

describe("parseListstreamXml", () => {
  it("parses concatenated file elements with mount-relative paths", () => {
    const xml = `<file>
  <path>/Archive/docs</path>
  <filename>a.md</filename>
  <md5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</md5>
  <size>3</size>
</file>
<file>
  <path>/Archive/docs</path>
  <filename>b.md</filename>
  <size>4</size>
</file>`;
    const entries = parseListstreamXml(xml);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.path, "/Archive/docs/a.md");
    assert.equal(entries[0]?.name, "a.md");
    assert.equal(entries[0]?.size, 3);
    assert.equal(entries[1]?.path, "/Archive/docs/b.md");
  });

  it("strips user/device prefix when present", () => {
    const xml = `<file>
      <path>/user1/Jotta/Archive/photos</path>
      <filename>x.jpg</filename>
      <size>9</size>
    </file>`;
    const entries = parseListstreamXml(xml);
    assert.equal(entries[0]?.path, "/Archive/photos/x.jpg");
  });
});

describe("parseMountPoints", () => {
  it("lists Archive, Sync, and Trash", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<device name="Jotta">
  <mountPoints>
    <mountPoint name="Archive"/>
    <mountPoint name="Sync"/>
    <mountPoint name="Trash"/>
  </mountPoints>
</device>`;
    assert.deepEqual(parseMountPoints(xml), ["/Archive", "/Sync", "/Trash"]);
  });
});

describe("toAgentPath / publicDownloadUrl", () => {
  it("joins filename onto a mount-relative folder", () => {
    assert.equal(toAgentPath("/Archive/docs", "a.md"), "/Archive/docs/a.md");
  });

  it("builds the public download URL", () => {
    assert.equal(
      publicDownloadUrl("user1", "abc"),
      "https://www.jottacloud.com/opin/io/downloadPublic/user1/abc",
    );
  });
});
