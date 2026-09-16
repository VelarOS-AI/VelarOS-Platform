/** 管线阶段名：内核在处理这五类请求之前，把输入交给挂在同名阶段上的各段改写。 */
export type PipelinePhase = 'observe.input' | 'read.input' | 'search.input' | 'resolve.input' | 'prepare.input'

/** 核心操作前运行的转换 stage 接收到的上下文。 */
export interface PipelineContext {
  kernel: any;
  phase: PipelinePhase;
}
