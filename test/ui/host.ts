// Synthetic MCP Apps host, used only by browser QA. Never included in the app bundle.
const roots = ["/Sync", "/Archive"];
const welcome =
  "# Welcome\n\nYour files, close to the conversation.\n\nBrowse folders, preview a document,\nand choose what to bring into chat.";
const row = (name: string, kind = "file", extra = {}) => ({
  name,
  kind,
  path: `/Sync/Documents/${name}`,
  uri: `jotta:///Sync/Documents/${encodeURIComponent(name)}`,
  modified: "2024-11-10T12:17:00Z",
  ...extra,
});
const entries = [
  row("Projects", "folder"),
  row("Travel", "folder"),
  row("Welcome.md", "file", { size: 184, mime: "text/markdown" }),
  row("Packing list.txt", "file", { size: 1229, mime: "text/plain" }),
  row("Notes.json", "file", { size: 980, mime: "application/json" }),
  row("Handbook.pdf", "file", { size: 2516582, mime: "application/pdf" }),
];
const state = window as unknown as {
  __events: unknown[];
  __failure?: string;
  __slow?: boolean;
};
state.__events = [];
window.addEventListener("message", async (event) => {
  if (event.source !== document.querySelector("iframe")?.contentWindow) return;
  const m = event.data;
  if (m.jsonrpc !== "2.0" || m.id === undefined) return;
  state.__events.push(m);
  const send = (result: unknown) =>
    event.source!.postMessage(
      { jsonrpc: "2.0", id: m.id, result },
      { targetOrigin: event.origin },
    );
  if (m.method === "ui/initialize") {
    send({
      protocolVersion: m.params.protocolVersion,
      hostInfo: { name: "test-host", version: "1" },
      hostCapabilities: {
        serverTools: {},
        updateModelContext: {},
        message: { text: {}, image: {} },
      },
      hostContext: { theme: "light", displayMode: "fullscreen" },
    });
    return;
  }
  if (m.method === "tools/call") {
    const { name, arguments: args } = m.params;
    if (state.__failure === name) {
      send({
        isError: true,
        content: [{ type: "text", text: "Synthetic connection failure." }],
      });
      return;
    }
    if (state.__slow && name === "preview_file")
      await new Promise((resolve) => setTimeout(resolve, 300));
    if (name === "browse_files" || name === "search_browser_files") {
      const path = args.path ?? "/Sync/Documents";
      let list =
        path === "/Archive"
          ? []
          : path === "/Sync"
            ? [
                {
                  name: "Documents",
                  kind: "folder",
                  path: "/Sync/Documents",
                  uri: "jotta:///Sync/Documents",
                },
              ]
            : path.endsWith("/Projects")
              ? []
              : entries;
      if (args.query)
        list = list.filter((e) =>
          e.name.toLowerCase().includes(args.query.toLowerCase()),
        );
      send({
        content: [],
        structuredContent: {
          roots,
          path,
          entries: list,
          count: list.length,
          truncated: false,
          query: args.query,
        },
      });
      return;
    }
    const entry =
      entries.find((e) => e.path === args.path) ??
      row("<img src=x onerror=alert(1)>.txt", "file", { size: 184 });
    if (name === "preview_file") {
      const preview = {
        entry,
        kind: entry.name.endsWith(".pdf") ? "unsupported" : "text",
        content:
          entry.name === "Welcome.md"
            ? welcome
            : '<script>alert("unsafe")</script>',
        truncated: false,
      };
      send({
        content: [],
        structuredContent: { entry, kind: preview.kind, truncated: false },
        _meta: { preview },
      });
      return;
    }
    if (name === "select_file") {
      send({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: entry.path,
              untrustedFileContent: welcome,
            }),
          },
        ],
        structuredContent: { entry, truncated: false },
      });
      return;
    }
  }
  if (m.method === "ui/message" && state.__failure === "ui/message") {
    send({ isError: true });
    return;
  }
  send({});
});
