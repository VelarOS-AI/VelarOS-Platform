import type {
  Detector,
  DetectorContext,
  DetectorDefinition,
  Finding,
  Observation,
} from "../protocol/index.js";

export interface RegisteredDetector {
  readonly definition: DetectorDefinition;
  readonly detect: Detector;
}

export class DetectorRegistry {
  private readonly detectors = new Map<string, RegisteredDetector>();

  public register(detector: RegisteredDetector): void {
    if (this.detectors.has(detector.definition.id)) {
      throw new Error(`Detector already registered: ${detector.definition.id}`);
    }
    this.detectors.set(detector.definition.id, detector);
  }

  public get(id: string): RegisteredDetector | null {
    return this.detectors.get(id) ?? null;
  }

  public list(): readonly RegisteredDetector[] {
    return [...this.detectors.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id),
    );
  }

  public detect(
    observation: Observation,
    context: DetectorContext,
  ): readonly Finding[] {
    const findings: Finding[] = [];
    for (const detector of this.list()) {
      const { definition } = detector;
      if (!definition.phases.includes(observation.phase)) continue;
      if (observation.coverage[definition.face] === "none") continue;
      findings.push(...detector.detect(observation, context));
    }
    return findings;
  }
}
