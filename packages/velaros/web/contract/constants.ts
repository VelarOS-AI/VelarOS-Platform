/**
 * 约定的常量表（对外合同的一部分）：`velaros:web` 的错误码与公开上限。
 * 程序与宿主按错误码判断失败；上限直接被入参核对引用，也是模型在声明里看到的数字（两边一致由验收核对）。
 * 包内可调、不对外承诺的参数（超时、等渲染的时长、记住 Google 搜不通多久）在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./web/contracts` 入口出单元。
 */

/**
 * web 能力对外承诺的错误语义：操作失败时抛的专属码，模型的程序与宿主都按它分支。
 * 码本身是契约的一部分，不得改名；文字说明随时可能改。入参不对沿用通用的 `VALIDATION`，取消抛取消原因。
 */
export const WebErrorCodes = Object.freeze({
  /** 两个搜索引擎都搜不了：打不开、超时、被拦成验证页，或者结果页里认不出一条结果；message 分别写着两边为什么。 */
  searchFailed: 'WEB_SEARCH_FAILED',
  /** 网页打不开：地址连不上、加载出错，或者到了时限还什么都没加载出来。 */
  pageUnreachable: 'WEB_PAGE_UNREACHABLE',
  /** 网页打开了却读不成文字：是 PDF 这类文件而不是网页，或者读正文的页面脚本没跑成。 */
  pageUnreadable: 'WEB_PAGE_UNREADABLE',
} as const)

/** 错误码的联合类型，外面按它分支处理失败。 */
export type WebErrorCode = (typeof WebErrorCodes)[keyof typeof WebErrorCodes]

/** `velaros:web` 对外承诺的上限与缺省值：写进声明给模型看，入参核对用的也是这一份。 */
export const WebLimits = Object.freeze({
  /** search 不给 limit 时最多交回几条结果。 */
  defaultResults: 8,
  /** search 一次最多交回几条结果。 */
  maxResults: 20,
  /** 搜索词最多多少个字符。 */
  queryChars: 1_000,
  /** read 不给 maxChars 时一次读多少个字符。 */
  defaultReadChars: 8_000,
  /** read 一次最多读多少个字符。 */
  maxReadChars: 20_000,
  /** 网址最多多少个字符。 */
  urlChars: 4_096,
} as const)
