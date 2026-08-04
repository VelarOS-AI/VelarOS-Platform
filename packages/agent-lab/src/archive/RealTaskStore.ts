import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  RealTaskAssessment,
  RealTaskCase,
  RealTaskRecord,
} from "../workload/index.js";
import {
  parseRealTaskAssessment,
  parseRealTaskCase,
  parseRealTaskRecord,
  renderRealTaskReportHtml,
} from "../workload/index.js";

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, path);
}

export async function writeRealTaskBundle(
  directory: string,
  recordInput: RealTaskRecord,
  assessmentInput: RealTaskAssessment,
): Promise<{ readonly record: string; readonly assessment: string; readonly report: string }> {
  const record = parseRealTaskRecord(recordInput);
  const assessment = parseRealTaskAssessment(assessmentInput);
  if (assessment.recordId !== record.id) {
    throw new Error("Real task assessment does not belong to the supplied record");
  }
  const root = resolve(directory);
  const recordPath = join(root, "record.json");
  const assessmentPath = join(root, "assessment.json");
  const reportPath = join(root, "report.html");
  await atomicJson(recordPath, record);
  await atomicJson(assessmentPath, assessment);
  await writeFile(reportPath, renderRealTaskReportHtml(record, assessment), "utf8");
  return { record: recordPath, assessment: assessmentPath, report: reportPath };
}

export async function readRealTaskRecord(path: string): Promise<RealTaskRecord> {
  return parseRealTaskRecord(JSON.parse(await readFile(resolve(path), "utf8")));
}

export async function writeRealTaskCase(
  path: string,
  input: RealTaskCase,
): Promise<string> {
  const target = resolve(path);
  await atomicJson(target, parseRealTaskCase(input));
  return target;
}

export async function readRealTaskCase(path: string): Promise<RealTaskCase> {
  return parseRealTaskCase(JSON.parse(await readFile(resolve(path), "utf8")));
}
