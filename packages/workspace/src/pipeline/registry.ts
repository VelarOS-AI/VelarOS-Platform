import type { PipelineStage } from "../types/pipeline.js";

export class PipelineRegistry {
  private stages: PipelineStage[] = [];

  public register(stage: PipelineStage): void {
    this.stages.push(stage);
    this.stages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  public list(): PipelineStage[] {
    return [...this.stages];
  }

  public async run<T>(phase: string, input: T, kernel: any): Promise<T> {
    let current: any = input;
    for (const stage of this.stages.filter((s) => s.phase === phase)) {
      current = await stage.run(current, { kernel, phase });
    }
    return current as T;
  }
}
