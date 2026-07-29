import type { FileAdapter, FileAdapterFactory } from "../types/adapter.js";
import type { FileSnapshot } from "../types/snapshot.js";
import { ext } from "../utils/path.js";

export function jsonAdapterFactory(): FileAdapterFactory {
  return {
    id: "core.json.factory",
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isBinary && ext(snapshot.path) === ".json";
    },
    create() {
      const adapter: FileAdapter = {
        id: "core.json",
        kind: "structured-data",
        priority: 40,
        capabilities: ["read", "validate", "prepare_edit"],
        parse({ snapshot }) {
          try {
            JSON.parse(snapshot.content ?? "");
            return { ok: true, diagnostics: [] };
          } catch (error) {
            return {
              ok: false,
              diagnostics: [{ severity: "error", message: `JSON 解析失败：${(error as Error).message}`, path: snapshot.path, source: "core.json" }],
            };
          }
        },
        validate({ snapshot, changedContent }) {
          try {
            JSON.parse(changedContent ?? snapshot.content ?? "");
            return { ok: true, diagnostics: [], checks: [{ id: "core.json", ok: true }] };
          } catch (error) {
            return {
              ok: false,
              diagnostics: [{ severity: "error", message: `JSON 校验失败：${(error as Error).message}`, path: snapshot.path, source: "core.json" }],
              checks: [{ id: "core.json", ok: false }],
            };
          }
        },
      };
      return adapter;
    },
  };
}
