import type { ClassifiedContextWorkingSet, ClassifyContextWorkingSetInput, ContextWorkingSetBlock } from '../../types/context.js'
import { classifyContextWorkingSet, classifyRetainedContextWorkingSet } from '../../utils/context/context-working-set-os'

/**
 * 上下文工作集的分类器：把一次供应方请求的原料切成带分区、优先级与回收方式的块表，宿主可整体替换。
 *
 * 分类规则本身是纯函数（utils/context/context-working-set-os.ts），这里只把它们收成一件可注入的东西，
 * 让宿主换掉「什么进哪个分区、哪些块不许腾」时不必改编译请求的那条主链。只分类，不做任何裁剪与回收。
 */
export interface ContextWorkingSetOSApi {
  /**
   * 只切「无论如何都要保留」的那两类块：当前任务与固定证据。
   * 治理阶段要先知道保留部分占多少才能算预留额度，所以它能单独调，不必先备齐消息与工具 schema。
   */
  classifyRetainedContext(
    input: Pick<ClassifyContextWorkingSetInput, 'activeTask' | 'pinnedEvidence' | 'resourceState'>
  ): ContextWorkingSetBlock[]
  /**
   * 切出本轮完整的工作集块表：系统提示词、保留上下文、历史消息（带失败原因的 tool 结果额外配一个诊断块）、
   * 工具 schema 与检索句柄。纯计算，不落任何状态；输入缺项按空处理，不抛错。
   */
  classify(input: ClassifyContextWorkingSetInput): ClassifiedContextWorkingSet
}

export class ContextWorkingSetOS implements ContextWorkingSetOSApi {
  public classifyRetainedContext(
    input: Pick<ClassifyContextWorkingSetInput, 'activeTask' | 'pinnedEvidence' | 'resourceState'>
  ): ContextWorkingSetBlock[] {
    return classifyRetainedContextWorkingSet(input)
  }

  public classify(input: ClassifyContextWorkingSetInput): ClassifiedContextWorkingSet {
    return classifyContextWorkingSet(input)
  }
}
