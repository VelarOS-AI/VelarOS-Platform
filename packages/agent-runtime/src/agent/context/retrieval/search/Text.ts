/**
 * 搜索/检索链路的文本工具：字符预算 clamp、截断、payload 序列化。
 *
 * ## 职责边界
 * - **不做**分词、打分、索引——只做长度与格式
 * - 被 {@link ChatSearchMessages}、{@link ContextRetrievalIndexBuilder}、
 *   {@link ContextRetrievalPayloadReader}、{@link ContextRetrievalReferenceReader}、
 *   {@link ChatContextRetrievalService} 共用
 *
 * 导出单例 {@link chatSearchText}。
 */
import { isFiniteNumber, isString, Log,stringifyPretty } from '@velaros-ai/core'
class ChatSearchText {
  /** 调用方未传 maxChars 或传非法值时的默认 retrieve 字符上限。 */
  private readonly defaultMaxRetrieveChars = 8_000
  /** retrieve/read 允许的硬顶，防止 agent 一次拉取过大正文。 */
  private readonly maxRetrieveChars = 30_000
  /** 搜索 API 未传 maxResults 时的默认返回条数。 */
  private readonly defaultSearchResults = 8
  /** 搜索 API 允许的最大返回条数。 */
  private readonly maxSearchResults = 20

  /**
   * 规范化单次 retrieve/read 的正文字符上限。
   *
   * @param value 来自 IPC 请求的 maxChars；undefined/非正数则用 defaultMaxRetrieveChars
   * @returns `[1, maxRetrieveChars]` 内的整数
   */
  public clampMaxChars(value: LooseOptional<number>): number {
    return isFiniteNumber(value) && value > 0
      ? Math.min(Math.floor(value), this.maxRetrieveChars)
      : this.defaultMaxRetrieveChars
  }

  /**
   * 规范化搜索结果条数上限。
   *
   * @param value 来自 IPC 的 maxResults
   * @returns `[1, maxSearchResults]` 内的整数
   */
  public clampMaxResults(value: LooseOptional<number>): number {
    return isFiniteNumber(value) && value > 0
      ? Math.min(Math.floor(value), this.maxSearchResults)
      : this.defaultSearchResults
  }

  /**
   * 截断字符串：先 trim，超长则取前 maxChars 字符并 trimEnd 后加 `...`。
   *
   * @param value 原始文本
   * @param maxChars 含省略号前的最大长度（省略号另占 3 字符逻辑在 slice 内）
   */
  public truncate(value: string, maxChars: number): string {
    const trimmed = value.trim()
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}...` : trimmed
  }

  /**
   * 将工具 args、displayResult、serialized 等**任意值**转为可搜索/可展示的字符串。
   *
   * - 已是 string：直接 truncate
   * - 对象/数组：优先 `JSON.stringifyPretty`，再 truncate
   * - stringify 抛错：debug 日志 + `String(value)` 降级
   *
   * @param value 工具 payload 字段、消息 block 等
   * @param maxChars 输出上限
   */
  public stringifyPayload(value: any, maxChars: number): string {
    if (isString(value)) return this.truncate(value, maxChars)

    try {
      return this.truncate(stringifyPretty(value), maxChars)
    } catch (error) {
      Log.tag('ChatSearchText').debug('序列化搜索 payload 失败', { error })
      return this.truncate(String(value), maxChars)
    }
  }
}

/** 全进程唯一的文本工具实例。 */
const chatSearchText = new ChatSearchText()

export { chatSearchText }
