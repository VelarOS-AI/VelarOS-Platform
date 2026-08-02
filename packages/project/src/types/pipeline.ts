/** 核心操作前运行的转换 stage 接收到的上下文。 */
export interface PipelineContext {
  kernel: any;
  phase: string;
}

/** 针对指定内核 phase 的有序输入/输出转换 hook。 */
export interface PipelineStage<I = any, O = any> {
  id: string;
  phase: string;
  order?: number;
  run(input: I, ctx: PipelineContext): Promise<O> | O;
}
