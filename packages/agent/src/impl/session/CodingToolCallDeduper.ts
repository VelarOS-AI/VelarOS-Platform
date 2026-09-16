
import { buildToolFingerprint } from '../../utils/session/tool-dedupe'







/**
 * CodingToolCallDeduper — 拦截幂等工具的“重复刷屏”行为。
 *
 * 背景：模型有时会连续多次发出完全相同的 tooling:replace/read/map / plan:update，
 * 既浪费 token 又会让用户看到大段重复输出。这里基于规范化后的入参指纹来：
 *  - 命中相同 fingerprint：返回提示文案，由调用方写入工具结果替代真正的执行；
 * 这里刻意只判断“完全相同的调用是否刚执行过”，不根据能力授权状态推断工具页是否驻留。
 * 能力已授权与具体工具 schema 已进入本轮 tools 是两个独立状态；后者只能由
 * ToolSpaceReplace 按当前驻留信息处理。
 *
 * fingerprint 规范化通过 `normalizeToolCallFingerprintValue` 对对象 key 排序，
 * 保证模型用不同 key 顺序生成的参数仍可命中同一指纹。
 */
class CodingToolCallDeduper {
  private readonly lastIdempotentToolCallFingerprints = new Map<string, string>()

  public recordIdempotentToolCall(toolName: string, args: Record<string, unknown>): void {
    const fingerprint = buildToolFingerprint(toolName, args)
    if (!fingerprint) return

    this.lastIdempotentToolCallFingerprints.set(toolName, fingerprint)
  }

  public getRepeatedIdempotentToolCallMessage(
    toolName: string,
    args: Record<string, unknown>
  ): LooseOptional<string> {
    const fingerprint = buildToolFingerprint(toolName, args)
    if (!fingerprint || this.lastIdempotentToolCallFingerprints.get(toolName) !== fingerprint) return null

    switch (toolName) {
      case 'plan:update': {
        return [
        '已拦截重复计划更新：当前计划内容与刚才完全相同。',
        '不要继续重复 plan:update；请直接调用实际执行工具推进任务，或在无法推进时说明阻塞点并询问用户。',
      ].join('\n')
      }
      default: {
        return [
      '已拦截重复工具空间操作：相同的工具页请求刚才已经处理过。',
      `不要继续重复 ${toolName}；若工具页已换入，请等待下一轮按 AI SDK 暴露的真实工具 schema 调用，或继续下一步。`,
    ].join('\n')
      }
    }
  }

}

export { buildToolFingerprint,CodingToolCallDeduper }
