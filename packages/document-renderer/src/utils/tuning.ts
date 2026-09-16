/**
 * 包内可调参数：缺省条数与裁剪长度。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 对外承诺的上限（requestId、路径、maxItems、scale、PDF 像素）不在这里，在 `contract/constants.ts`：改那边等于改契约。
 */

/** 文档渲染器的可调参数，按用途分组。 */
export const DocumentRendererTuning = Object.freeze({
  /** Office 预览：解析多少内容。 */
  office: Object.freeze({
    /** 请求没填 maxItems 时预览多少项（行、幻灯片、段落）；上限是 DocumentRendererLimits.maximumOfficeItems。 */
    defaultMaxItems: 80,
  }),
  /** INVALID_REQUEST 回执的裁剪：说明要一眼能读完。 */
  invalidRequest: Object.freeze({
    /** 一条回执最多列几处校验问题；再多调用方也读不过来，剩下的只报个数。 */
    reportedIssues: 5,
    /** 单处说明最多留多少字符：避免把超长的输入值原样贴进回执。 */
    messageChars: 80,
  }),
} as const)
