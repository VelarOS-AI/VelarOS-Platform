import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { RunArchiveView } from "./ArchiveView.js";
import { readRunArchiveView } from "./ArchiveView.js";

export interface DiscoveredRunArchive {
  readonly directory: string;
  readonly path: string;
  readonly source: "report" | "progress";
  readonly view: RunArchiveView;
}

export interface RunArchiveDiscovery {
  readonly archives: readonly DiscoveredRunArchive[];
  readonly skippedDirectories: number;
  readonly unreadableDirectories: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readCandidate(
  directory: string,
): Promise<DiscoveredRunArchive | null> {
  for (const name of ["report.json", "progress.json"] as const) {
    const path = join(directory, name);
    if (!(await exists(path))) continue;
    try {
      const view = readRunArchiveView(JSON.parse(await readFile(path, "utf8")));
      if (view.shape === "invalid" || view.shape === "missing") continue;
      return {
        directory,
        path,
        source: name === "report.json" ? "report" : "progress",
        view,
      };
    } catch {
      // A partially written report may have a readable progress fallback.
    }
  }
  return null;
}

/**
 * Discovers one archive per run directory, preferring report.json and falling back to progress.json.
 * Unrelated JSON fixtures are intentionally not invented into a fourth archive format.
 */
export async function discoverRunArchives(
  root: string,
): Promise<RunArchiveDiscovery> {
  const absolute = resolve(root);
  const details = await stat(absolute);
  if (!details.isDirectory())
    throw new Error(`Run archive root is not a directory: ${absolute}`);

  const direct = await readCandidate(absolute);
  if (direct)
    return {
      archives: [direct],
      skippedDirectories: 0,
      unreadableDirectories: [],
    };

  const entries = await readdir(absolute, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(absolute, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
  const archives: DiscoveredRunArchive[] = [];
  const unreadable: string[] = [];
  let skippedDirectories = 0;
  for (const directory of directories) {
    const hasCandidate =
      (await exists(join(directory, "report.json"))) ||
      (await exists(join(directory, "progress.json")));
    if (!hasCandidate) {
      skippedDirectories += 1;
      continue;
    }
    const archive = await readCandidate(directory);
    if (archive) archives.push(archive);
    else unreadable.push(directory);
  }
  return {
    archives,
    skippedDirectories,
    unreadableDirectories: unreadable,
  };
}
