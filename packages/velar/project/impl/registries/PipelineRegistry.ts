/**
 * 转换管线登记表：`PipelineRegistry`。接口 `PipelineRegistryApi` 在本文件的类上方。
 */

import type { PipelineStage } from '../../contract/requires.js'
import type { PipelinePhase } from '../../types/pipeline.js'

/** 管理转换 stage（插件经 registerPipelineStage 登记）：内核在某个 phase（如 prepare.input）把输入依次交给该 phase 的 stage 改写。实例由内核持有，一个内核一份。 */
export interface PipelineRegistryApi {
  /** 登记一个 stage，并按 order 从小到大重新排序（同 order 保持登记顺序）。 */
  register(stage: PipelineStage): void;
  /** 已登记的全部 stage（拷贝的数组），按 order 排好。 */
  list(): PipelineStage[];
  /** 把输入依次交给这个 phase 的 stage，每个 stage 的输出是下一个的输入，返回最后的结果；没有 stage 时原样返回。stage 抛出的错误原样抛出。 */
  run<T>(phase: PipelinePhase, input: T, kernel: any): Promise<T>;
}

export class PipelineRegistry implements PipelineRegistryApi {
  private stages: PipelineStage[] = [];

  public register(stage: PipelineStage): void {
    this.stages.push(stage);
    this.stages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  public list(): PipelineStage[] {
    return [...this.stages];
  }

  public async run<T>(phase: PipelinePhase, input: T, kernel: any): Promise<T> {
    let current: any = input;
    for (const stage of this.stages.filter((s) => s.phase === phase)) {
      current = await stage.run(current, { kernel, phase });
    }
    return current as T;
  }
}
