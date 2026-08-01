#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverRunArchives,
  readRunArchiveView,
  writeRunArchive,
} from "./archive/index.js";
import {
  certifySubject,
  parseCertificationPolicy,
  parseCertificationSubject,
} from "./certification/index.js";
import type { JsonValue, RunArchive } from "./protocol/index.js";
import {
  parseJobSpec,
  parseJourneySpec,
  parseRunArchive,
} from "./protocol/index.js";
import {
  createRunReportModel,
  renderHistoricalReportHtml,
  renderReportHtml,
} from "./report/index.js";
import type { AgentLabRuntime, CreateAgentLabRuntime } from "./runner/index.js";
import { runJob, runJourney } from "./runner/index.js";
import { compareExecutors } from "./statistics/index.js";

interface ParsedArguments {
  readonly command: string | null;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = null, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.slice(2).split("=", 2);
    const next = rest[index + 1];
    if (inlineValue !== undefined) flags[rawName] = inlineValue;
    else if (next && !next.startsWith("--")) {
      flags[rawName] = next;
      index += 1;
    } else flags[rawName] = true;
  }
  return { command, positionals, flags };
}

function requiredFlag(arguments_: ParsedArguments, name: string): string {
  const value = arguments_.flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function loadArchiveInputs(paths: readonly string[]): Promise<{
  readonly archives: readonly RunArchive[];
  readonly views: ReadonlyArray<ReturnType<typeof readRunArchiveView>>;
}> {
  const views = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const details = await stat(absolute);
    if (details.isFile())
      views.push(readRunArchiveView(await jsonFile(absolute)));
    else if (details.isDirectory()) {
      const discovery = await discoverRunArchives(absolute);
      views.push(...discovery.archives.map((entry) => entry.view));
      if (discovery.unreadableDirectories.length > 0) {
        throw new Error(
          `Unreadable run archives: ${discovery.unreadableDirectories.join(", ")}`,
        );
      }
    }
  }
  return {
    archives: views.flatMap((view) => (view.archive ? [view.archive] : [])),
    views,
  };
}

async function validate(arguments_: ParsedArguments): Promise<void> {
  const [kind, path] = arguments_.positionals;
  if (!kind || !path)
    throw new Error(
      "Usage: velaros-agent-lab validate <journey|job|run> <file>",
    );
  const value = await jsonFile(path);
  if (kind === "journey") parseJourneySpec(value);
  else if (kind === "job") parseJobSpec(value);
  else if (kind === "run") parseRunArchive(value);
  else throw new Error(`Unknown validation kind: ${kind}`);
  process.stdout.write(`valid ${kind}: ${resolve(path)}\n`);
}

async function report(arguments_: ParsedArguments): Promise<void> {
  if (arguments_.positionals.length === 0)
    throw new Error("Report needs one or more files or directories");
  const output = resolve(requiredFlag(arguments_, "output"));
  const loaded = await loadArchiveInputs(arguments_.positionals);
  if (loaded.views.length === 0) throw new Error("No JSON archives found");
  const html =
    loaded.archives.length === loaded.views.length
      ? renderReportHtml(loaded.archives.map(createRunReportModel), {
          generatedAt: Date.now(),
        })
      : renderHistoricalReportHtml(loaded.views, { generatedAt: Date.now() });
  await writeFile(output, html, "utf8");
  process.stdout.write(`${output}\n`);
}

async function compare(arguments_: ParsedArguments): Promise<void> {
  const executorA = requiredFlag(arguments_, "a");
  const executorB = requiredFlag(arguments_, "b");
  const loaded = await loadArchiveInputs(arguments_.positionals);
  const result = compareExecutors(loaded.archives, executorA, executorB, {
    minimumEffect:
      typeof arguments_.flags["minimum-effect"] === "string"
        ? Number(arguments_.flags["minimum-effect"])
        : 0,
    seed:
      typeof arguments_.flags.seed === "string"
        ? Number(arguments_.flags.seed)
        : 1,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision === "not-comparable") process.exitCode = 2;
}

async function createRuntime(modulePath: string): Promise<AgentLabRuntime> {
  const imported = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    readonly default?: CreateAgentLabRuntime;
    readonly createAgentLabRuntime?: CreateAgentLabRuntime;
  };
  const factory = imported.createAgentLabRuntime ?? imported.default;
  if (typeof factory !== "function") {
    throw new Error(
      "Runtime module must export createAgentLabRuntime or a default factory",
    );
  }
  return factory();
}

async function run(arguments_: ParsedArguments): Promise<void> {
  const job = parseJobSpec(await jsonFile(requiredFlag(arguments_, "job")));
  const runtime = await createRuntime(requiredFlag(arguments_, "runtime"));
  const archives = await runJob(job, {
    resolveDriver: (trial) => runtime.resolveDriver(trial),
    runTrial: async (trial, driver) =>
      runJourney({
        jobId: job.id,
        suiteId: job.suiteId,
        trial,
        journey: await runtime.getJourney(trial),
        driver,
        detectors: runtime.detectors,
        verifiers: runtime.verifiers,
        workspaceRoot: runtime.workspaceRoot,
        sourceCommit: runtime.sourceCommit,
        consumerCommit: runtime.consumerCommit,
      }),
    onArchive: async (archive) => {
      await writeRunArchive(job.archiveDirectory, archive);
    },
  });
  process.stdout.write(
    `${JSON.stringify({ runs: archives.length, archiveDirectory: resolve(job.archiveDirectory) }, null, 2)}\n`,
  );
}

async function certify(arguments_: ParsedArguments): Promise<void> {
  const policy = parseCertificationPolicy(
    await jsonFile(requiredFlag(arguments_, "policy")),
  );
  const subject = parseCertificationSubject(
    await jsonFile(requiredFlag(arguments_, "subject")),
  );
  const loaded = await loadArchiveInputs(arguments_.positionals);
  const baselinePath = arguments_.flags.baseline;
  const baseline =
    typeof baselinePath === "string"
      ? await loadArchiveInputs([baselinePath])
      : { archives: [] };
  const result = certifySubject({
    policy,
    subject,
    archives: loaded.archives,
    baselineArchives: baseline.archives,
    subjectExecutorId: requiredFlag(arguments_, "executor"),
    baselineExecutorId:
      typeof arguments_.flags["baseline-executor"] === "string"
        ? arguments_.flags["baseline-executor"]
        : undefined,
  });
  const output: JsonValue = result as unknown as JsonValue;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.status === "rejected") process.exitCode = 1;
  if (result.status === "inconclusive") process.exitCode = 2;
}

function help(): void {
  process.stdout.write(
    `VelarOS Agent Lab\n\nCommands:\n  validate <journey|job|run> <file>\n  run --job <job.json> --runtime <runtime.mjs>\n  report <file-or-dir...> --output <report.html>\n  compare <file-or-dir...> --a <executor> --b <executor> [--minimum-effect N]\n  certify <file-or-dir...> --policy <policy.json> --subject <subject.json> --executor <id>\n`,
  );
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (
    !arguments_.command ||
    arguments_.command === "help" ||
    arguments_.command === "--help" ||
    arguments_.command === "-h" ||
    arguments_.flags.help
  )
    return help();
  if (arguments_.command === "validate") return validate(arguments_);
  if (arguments_.command === "run") return run(arguments_);
  if (arguments_.command === "report") return report(arguments_);
  if (arguments_.command === "compare") return compare(arguments_);
  if (arguments_.command === "certify") return certify(arguments_);
  throw new Error(`Unknown command: ${arguments_.command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
