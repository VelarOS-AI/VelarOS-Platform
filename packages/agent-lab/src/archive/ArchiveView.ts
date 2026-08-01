import type { JsonObject, JsonValue, RunArchive } from "../protocol/index.js";
import { RunArchiveSchema } from "../protocol/index.js";

export type ArchiveShape =
  "v3" | "v2-manifest" | "v1-flat" | "v0-array" | "missing" | "invalid";

export interface RunArchiveView {
  readonly shape: ArchiveShape;
  readonly archive: RunArchive | null;
  readonly manifest: JsonObject | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly rounds: readonly JsonValue[];
  readonly passed: number | null;
  readonly total: number | null;
  readonly findings: readonly JsonValue[] | null;
  readonly drops: readonly JsonValue[] | null;
  readonly usage: JsonObject | null;
  readonly context: JsonObject | null;
  readonly raw: JsonValue | null;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue | null {
  const parsed = zJsonValue(value);
  return parsed.ok ? parsed.value : null;
}

function zJsonValue(
  value: unknown,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return { ok: true, value };
  if (typeof value === "number")
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    for (const item of value) {
      const parsed = zJsonValue(item);
      if (!parsed.ok) return { ok: false };
      values.push(parsed.value);
    }
    return { ok: true, value: values };
  }
  if (isRecord(value)) {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = zJsonValue(item);
      if (!parsed.ok) return { ok: false };
      object[key] = parsed.value;
    }
    return { ok: true, value: object };
  }
  return { ok: false };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonArray(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = jsonValue(item);
    return parsed === null ? [] : [parsed];
  });
}

function jsonObject(value: unknown): JsonObject | null {
  const parsed = jsonValue(value);
  return isRecord(parsed) ? (parsed as JsonObject) : null;
}

function empty(
  shape: ArchiveShape,
  raw: JsonValue | null,
  errors: readonly string[] = [],
): RunArchiveView {
  return {
    shape,
    archive: null,
    manifest: null,
    runId: null,
    sessionId: null,
    rounds: [],
    passed: null,
    total: null,
    findings: null,
    drops: null,
    usage: null,
    context: null,
    raw,
    errors,
  };
}

/**
 * Reads every historical archive shape without mutating or filling absent fields.
 */
export function readRunArchiveView(input: unknown): RunArchiveView {
  if (input === null || input === undefined) return empty("missing", null);
  const raw = jsonValue(input);
  if (raw === null)
    return empty("invalid", null, ["Archive is not valid JSON data"]);

  const v3 = RunArchiveSchema.safeParse(input);
  if (v3.success) {
    const archive = v3.data as RunArchive;
    return {
      shape: "v3",
      archive,
      manifest: jsonObject(archive.manifest),
      runId: archive.manifest.runId,
      sessionId: null,
      rounds: jsonArray(archive.legs),
      passed: archive.legs.every((leg) => leg.passed === null)
        ? null
        : archive.legs.filter((leg) => leg.passed === true).length,
      total: archive.legs.length,
      findings: jsonArray(archive.findings),
      drops: jsonArray(archive.drops),
      usage: jsonObject(archive.usage),
      context: jsonObject(archive.context),
      raw,
      errors: [],
    };
  }

  if (Array.isArray(input))
    return {
      ...empty("v0-array", raw),
      rounds: jsonArray(input),
      total: input.length,
    };
  if (!isRecord(input))
    return empty("invalid", raw, ["Archive root must be an object or array"]);

  if (isRecord(input.manifest)) {
    const rounds = jsonArray(input.rounds);
    return {
      ...empty("v2-manifest", raw),
      manifest: jsonObject(input.manifest),
      runId: nullableString(input.manifest.runId),
      sessionId: nullableString(input.manifest.sessionId),
      rounds,
      passed: nullableNumber(input.manifest.passedRounds),
      total: nullableNumber(input.manifest.totalRounds) ?? rounds.length,
      findings: Array.isArray(input.findings)
        ? jsonArray(input.findings)
        : null,
      drops: Array.isArray(input.drops) ? jsonArray(input.drops) : null,
      usage: jsonObject(input.usage),
      context: jsonObject(input.governance ?? input.context),
    };
  }

  const rounds = jsonArray(input.rounds ?? input.records ?? input.results);
  return {
    ...empty("v1-flat", raw),
    sessionId: nullableString(input.sessionId),
    rounds,
    passed: nullableNumber(input.passed),
    total:
      nullableNumber(input.total) ?? (rounds.length > 0 ? rounds.length : null),
    findings: Array.isArray(input.findings) ? jsonArray(input.findings) : null,
    drops: null,
    usage: jsonObject(input.usage),
    context: jsonObject(input.governance ?? input.context),
  };
}
