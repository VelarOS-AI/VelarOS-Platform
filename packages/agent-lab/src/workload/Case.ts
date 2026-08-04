import type {
  RealTaskAcceptanceContract,
  RealTaskCase,
  RealTaskRecord,
} from "./Types.js";
import { parseRealTaskCase, parseRealTaskRecord } from "./Types.js";

export interface PromoteRealTaskCaseInput {
  readonly id: string;
  readonly version?: number;
  readonly prompt?: string;
  readonly workspace: RealTaskCase["workspace"];
  readonly coverage: RealTaskCase["coverage"];
  readonly acceptance: readonly RealTaskAcceptanceContract[];
  readonly privacy: RealTaskCase["privacy"];
  readonly labels?: readonly string[];
  readonly createdAt?: number;
}

/**
 * Promotes an observed real task into an explicit replay contract. Promotion is intentionally
 * impossible without a prompt, an isolated workspace reference, and at least one acceptance gate.
 */
export function promoteRealTaskCase(
  input: RealTaskRecord,
  options: PromoteRealTaskCaseInput,
): RealTaskCase {
  const record = parseRealTaskRecord(input);
  const prompt = options.prompt?.trim() || record.task.prompt?.trim() || "";
  if (!prompt) throw new Error("A replay case requires an explicitly reviewed prompt");
  if (options.acceptance.length === 0) {
    throw new Error("A replay case requires at least one deterministic acceptance contract");
  }
  return parseRealTaskCase({
    schema: "agent-lab/real-task-case@3",
    id: options.id,
    version: options.version ?? 1,
    createdAt: options.createdAt ?? Date.now(),
    origin: { kind: "observed", recordId: record.id },
    title: record.task.title,
    prompt,
    source: record.task.source,
    surface: record.task.surface,
    coverage: options.coverage,
    workspace: options.workspace,
    acceptance: [...options.acceptance],
    privacy: options.privacy,
    labels: [...(options.labels ?? [])],
  });
}
