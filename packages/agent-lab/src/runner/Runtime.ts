import type { DetectorRegistry } from "../detect/index.js";
import type { JourneySpec, LabDriver, TrialSpec } from "../protocol/index.js";

import type { VerifierRegistry } from "./VerifierRegistry.js";

/** Public integration seam loaded by the CLI for a product-specific benchmark suite. */
export interface AgentLabRuntime {
  readonly detectors: DetectorRegistry;
  readonly verifiers: VerifierRegistry;
  readonly workspaceRoot: string | null;
  readonly sourceCommit: string | null;
  readonly consumerCommit: string | null;
  getJourney(trial: TrialSpec): Promise<JourneySpec> | JourneySpec;
  resolveDriver(trial: TrialSpec): Promise<LabDriver> | LabDriver;
}

export type CreateAgentLabRuntime = () =>
  Promise<AgentLabRuntime> | AgentLabRuntime;
