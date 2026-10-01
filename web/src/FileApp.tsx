import { useEffect, useRef, useState } from "react";
import type { BrowserEntry, BrowserPage, FilePreview } from "../../src/browser";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Bridge } from "./bridge";
function Icon({
  kind,
}: {
  kind: "cloud" | "folder" | "file" | "search" | "close";
}) {
  const paths = {
    cloud: "M6 18a4 4 0 0 1-.5-8 6.5 6.5 0 0 1 12-3A5.5 5.5 0 0 1 18 18Z",
    folder: "M3 6h6l2 2h10v12H3Z",
    file: "M6 3h8l4 4v14H6Zm8 0v5h4M9 12h6m-6 4h6",
    search: "M17 17l4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    close: "M5 5l14 14M19 5 5 19",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
function size(n?: number) {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024 ** (n < 1048576 ? 1 : 2)).toFixed(1)} ${n < 1048576 ? "KB" : "MB"}`;
}
function modified(raw?: string) {
  if (!raw) return "—";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString();
}
function pageFrom(result: CallToolResult): BrowserPage | undefined {
  const p = result.structuredContent as Record<string, unknown> | undefined;
  if (
    p &&
    Array.isArray(p.entries) &&
    typeof p.path === "string" &&
    Array.isArray(p.roots)
  )
    return p as BrowserPage;
}
export function FileApp({ bridge }: { bridge: Bridge }) {
  const [page, setPage] = useState<BrowserPage>();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<FilePreview>();
  const [busy, setBusy] = useState(true);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const ready = useRef(false);
  const accept = (result: CallToolResult) => {
    const p = pageFrom(result);
    if (p) {
      sequence.current++;
      previewSequence.current++;
      setPage(p);
      setPreview(undefined);
      setQuery(p.query ?? "");
      setBusy(false);
      setPreviewBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    bridge
      .connect((result) => {
        if (active) accept(result);
      })
      .then(async () => {
        ready.current = true;
        const initial = sequence.current;
        if (initial > 0) return;
        const result = await bridge.call("browse_files", {});
        if (active && !pageFrom(result))
          throw new Error("Invalid folder response.");
        if (active && sequence.current === initial) accept(result);
      })
      .catch((e) => {
        if (active) {
          setError(e instanceof Error ? e.message : "Could not connect.");
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [bridge]);
  async function navigate(
    path: string | undefined,
    search?: string,
    cursor?: string,
  ) {
    const id = ++sequence.current;
    previewSequence.current++;
    setBusy(true);
    setQuery(search ?? "");
    setPreview(undefined);
    setPreviewBusy(false);
    setError("");
    setNotice("");
    try {
      const result = await bridge.call(
        search ? "search_browser_files" : "browse_files",
        search ? { path, query: search } : { path, cursor },
      );
      const p = pageFrom(result);
      if (!p) throw new Error("Invalid folder response.");
      if (id !== sequence.current) return;
      setPage((old) =>
        cursor && old ? { ...p, entries: [...old.entries, ...p.entries] } : p,
      );
    } catch (e) {
      if (id === sequence.current)
        setError(e instanceof Error ? e.message : "Could not load files.");
    } finally {
      if (id === sequence.current) setBusy(false);
    }
  }
  async function open(entry: BrowserEntry) {
    if (entry.kind === "folder") {
      await navigate(entry.path);
      return;
    }
    const id = ++previewSequence.current;
    setPreview(undefined);
    setPreviewBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge.call("preview_file", { path: entry.path });
      const p = result._meta?.preview as FilePreview | undefined;
      if (!p || p.entry.path !== entry.path)
        throw new Error("Invalid preview response.");
      if (id === previewSequence.current) setPreview(p);
    } catch (e) {
      if (id === previewSequence.current)
        setError(
          e instanceof Error ? e.message : "Could not preview this file.",
        );
    } finally {
      if (id === previewSequence.current) setPreviewBusy(false);
    }
  }
  async function send() {
    if (!preview || sending) return;
    setSending(true);
    setError("");
    try {
      await bridge.useFile(preview.entry.path);
      setNotice("Added to conversation.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add this file.");
    } finally {
      setSending(false);
    }
  }
  const currentRoot = page?.roots
    .filter((r) => page.path === r || page.path.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  const crumbs =
    currentRoot && page
      ? [
          currentRoot,
          ...page.path
            .slice(currentRoot.length)
            .split("/")
            .filter(Boolean)
            .map((_, i, a) => `${currentRoot}/${a.slice(0, i + 1).join("/")}`),
        ]
      : [];
  return (
    <div className="app">
      <header>
        <span className="brand">
          <Icon kind="cloud" />
          Jottacloud
        </span>
        <span className="mode">Read only</span>
      </header>
      <div className={`layout ${preview || previewBusy ? "has-preview" : ""}`}>
        <nav aria-label="Locations">
          <p>Locations</p>
          {page?.roots.map((root) => (
            <button
              key={root}
              disabled={busy || sending}
              className={currentRoot === root ? "active" : ""}
              onClick={() => navigate(root)}
            >
              <Icon kind="folder" />
              {root.slice(1) || root}
            </button>
          ))}
          <small>Only your allowed folders</small>
        </nav>
        <main>
          <div className="breadcrumbs" aria-label="Folder path">
            {crumbs.map((path, i) => (
              <span key={path}>
                {i > 0 && <span className="separator">/</span>}
                <button
                  disabled={busy || sending}
                  onClick={() => navigate(path)}
                  aria-current={
                    i === crumbs.length - 1 ? "location" : undefined
                  }
                >
                  {i === 0 ? path.slice(1) : path.split("/").pop()}
                </button>
              </span>
            ))}
          </div>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (page && query.trim()) void navigate(page.path, query.trim());
            }}
          >
            <label>
              <Icon kind="search" />
              <input
                aria-label="Search file names"
                placeholder="Search file names"
                maxLength={200}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!page || busy || sending}
              />
            </label>
            <button
              className="primary"
              disabled={!page || busy || sending || !query.trim()}
            >
              Search
            </button>
            {page?.query && (
              <button
                type="button"
                disabled={busy || sending}
                onClick={() => navigate(page.path)}
              >
                Clear
              </button>
            )}
          </form>
          {error && (
            <div className="alert" role="alert">
              {error}
              <button
                disabled={busy || sending}
                onClick={() =>
                  page
                    ? void navigate(page.path, page.query)
                    : ready.current
                      ? void navigate(undefined)
                      : location.reload()
                }
              >
                Retry
              </button>
            </div>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {busy ? (
            <p className="empty" role="status">
              Loading files…
            </p>
          ) : (
            page && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>Modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.entries.map((entry) => (
                      <tr
                        key={entry.path}
                        className={
                          preview?.entry.path === entry.path ? "selected" : ""
                        }
                      >
                        <td>
                          <button
                            onClick={() => void open(entry)}
                            disabled={sending}
                          >
                            <Icon
                              kind={entry.kind === "folder" ? "folder" : "file"}
                            />
                            <span>{entry.name}</span>
                          </button>
                          {page.query && (
                            <small className="result-path">{entry.path}</small>
                          )}
                        </td>
                        <td>
                          {entry.kind === "folder" ? "—" : size(entry.size)}
                        </td>
                        <td>{modified(entry.modified)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!page.entries.length && (
                  <p className="empty">
                    {page.query
                      ? "No matching file names."
                      : "This folder is empty."}
                  </p>
                )}
                <footer>
                  {page.query ? `${page.count} matches` : `${page.count} items`}
                  {page.truncated && (
                    <span>
                      {" "}
                      · Search limit reached. Try a narrower folder or file
                      name.
                    </span>
                  )}
                  {page.nextCursor && (
                    <button
                      disabled={busy || sending}
                      onClick={() =>
                        navigate(page.path, undefined, page.nextCursor)
                      }
                    >
                      Load more
                    </button>
                  )}
                </footer>
              </>
            )
          )}
          {!page && !busy && !error && (
            <p className="empty">
              Open this browser from your connected Jottacloud plugin.
            </p>
          )}
        </main>
        {(preview || previewBusy) && (
          <aside aria-label="File preview">
            {previewBusy ? (
              <p role="status">Loading preview…</p>
            ) : (
              preview && (
                <>
                  <button
                    className="close"
                    aria-label="Close preview"
                    disabled={sending}
                    onClick={() => {
                      previewSequence.current++;
                      setPreview(undefined);
                    }}
                  >
                    <Icon kind="close" />
                  </button>
                  <h1>{preview.entry.name}</h1>
                  <p className="file-path">{preview.entry.path}</p>
                  <p className="preview-label">Preview</p>
                  {preview.kind === "text" ? (
                    <pre>{preview.content}</pre>
                  ) : preview.kind === "image" ? (
                    <img
                      alt={preview.entry.name}
                      src={`data:${preview.mime};base64,${preview.content}`}
                    />
                  ) : (
                    <p className="unsupported">
                      Preview is not available for this file type or size yet.
                    </p>
                  )}
                  {preview.truncated && (
                    <p className="limit">
                      Preview is incomplete. Only the available excerpt will be
                      added to the conversation.
                    </p>
                  )}
                  <dl>
                    <dt>Size</dt>
                    <dd>{size(preview.entry.size)}</dd>
                  </dl>
                  <button
                    className="primary use-file"
                    disabled={sending || preview.kind === "unsupported"}
                    onClick={() => void send()}
                  >
                    {sending ? "Adding…" : "Use in conversation"}
                  </button>
                </>
              )
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
