#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { discoverRunArchives } from "../src/archive/Discovery.ts";
import { renderHistoricalReportHtml } from "../src/report/HistoricalHtmlReport.ts";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function legacyView(report) {
  if (Array.isArray(report))
    return {
      shape: "v0-array",
      sessionId: null,
      rounds: report.length,
      passed: null,
      total: report.length,
    };
  if (report.manifest) {
    const rounds = report.rounds ?? [];
    return {
      shape: "v2-manifest",
      sessionId: report.manifest.sessionId ?? null,
      rounds: rounds.length,
      passed: report.manifest.passedRounds ?? null,
      total: report.manifest.totalRounds ?? rounds.length,
    };
  }
  const rounds = report.rounds ?? report.records ?? report.results ?? [];
  return {
    shape: "v1-flat",
    sessionId: report.sessionId ?? null,
    rounds: rounds.length,
    passed: report.passed ?? null,
    total: report.total ?? (rounds.length || null),
  };
}

function currentView(view) {
  return {
    shape: view.shape,
    sessionId: view.sessionId,
    rounds: view.rounds.length,
    passed: view.passed,
    total: view.total,
  };
}

const argv = process.argv.slice(2);
const expected = Number(flag(argv, "--expect") ?? 0);
const snapshotPath = flag(argv, "--snapshot");
const json = argv.includes("--json");
const roots = argv.filter((value, index) => {
  if (value.startsWith("--")) return false;
  if (index > 0 && ["--expect", "--snapshot"].includes(argv[index - 1]))
    return false;
  return true;
});
if (roots.length === 0) throw new Error("Provide one or more legacy run roots");

const entries = [];
let skippedDirectories = 0;
const unreadableDirectories = [];
for (const root of roots) {
  const discovery = await discoverRunArchives(root);
  skippedDirectories += discovery.skippedDirectories;
  unreadableDirectories.push(...discovery.unreadableDirectories);
  for (const archive of discovery.archives) {
    const bytes = await readFile(archive.path);
    const raw = JSON.parse(bytes.toString("utf8"));
    const before = legacyView(raw);
    const after = currentView(archive.view);
    const differences = Object.keys(before).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    const html = renderHistoricalReportHtml([archive.view], { generatedAt: 1 });
    entries.push({
      root: `${basename(dirname(root))}/${basename(root)}`,
      directory: basename(archive.directory),
      file: basename(archive.path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      shape: archive.view.shape,
      differences,
      unknownFields: [
        archive.view.findings === null ? "findings" : null,
        archive.view.drops === null ? "drops" : null,
        archive.view.usage === null ? "usage" : null,
        archive.view.context === null ? "context" : null,
      ].filter(Boolean),
      selfContained: html.length > 0,
    });
  }
}

entries.sort((left, right) =>
  `${left.root}/${left.directory}`.localeCompare(
    `${right.root}/${right.directory}`,
  ),
);
const failures = [
  ...(expected > 0 && entries.length !== expected
    ? [`expected ${expected} archives, found ${entries.length}`]
    : []),
  ...unreadableDirectories.map((path) => `unreadable: ${path}`),
  ...entries.flatMap((entry) =>
    entry.differences.map(
      (difference) => `${entry.root}/${entry.directory}: ${difference} differs`,
    ),
  ),
];
if (snapshotPath) {
  const snapshotRows = (await readFile(snapshotPath, "utf8"))
    .trim()
    .split("\n")
    .slice(3)
    .map((line) => {
      const [root, directory, file, sha256, shape] = line.split("\t");
      return { root, directory, file, sha256, shape };
    });
  const actualRows = entries.map(
    ({ root, directory, file, sha256, shape }) => ({
      root,
      directory,
      file,
      sha256,
      shape,
    }),
  );
  if (JSON.stringify(snapshotRows) !== JSON.stringify(actualRows)) {
    failures.push("legacy archive identity snapshot differs");
  }
}
const result = {
  schema: "agent-lab/legacy-equivalence@1",
  archives: entries.length,
  shapes: Object.fromEntries(
    [...new Set(entries.map((entry) => entry.shape))]
      .sort()
      .map((shape) => [
        shape,
        entries.filter((entry) => entry.shape === shape).length,
      ]),
  ),
  skippedDirectories,
  unreadableDirectories,
  entries,
  failures,
};

if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(
    `legacy equivalence: ${result.archives} archives ${JSON.stringify(result.shapes)}, ${failures.length} failures\n`,
  );
}
if (failures.length > 0) process.exitCode = 1;
