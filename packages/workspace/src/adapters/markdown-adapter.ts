import type { FileAdapter, FileAdapterFactory } from "../types/adapter.js";
import type { FileSnapshot } from "../types/snapshot.js";
import { ext } from "../utils/path.js";

export function markdownAdapterFactory(): FileAdapterFactory {
  return {
    id: "core.markdown.factory",
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isBinary && [".md", ".markdown", ".mdx"].includes(ext(snapshot.path));
    },
    create() {
      const adapter: FileAdapter = {
        id: "core.markdown",
        kind: "text",
        priority: 20,
        capabilities: ["read", "search", "validate"],
        parse({ snapshot }) {
          const headings = (snapshot.content ?? "")
            .split("\n")
            .map((line, i) => ({ line, i }))
            .filter(({ line }) => /^#{1,6}\s+/.test(line))
            .map(({ line, i }) => ({ kind: "heading", name: line.replace(/^#+\s+/, ""), range: { startLine: i + 1, endLine: i + 1 } }));
          return { ok: true, symbols: headings, diagnostics: [] };
        },
      };
      return adapter;
    },
  };
}
