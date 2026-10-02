/**
 * 这次程序随身带来的数据。
 */
declare module 'velaros:program' {
  /** 随程序一起交来的大段文本，按名字取。文件正文、补丁放这里，不写进源码——写进源码要过好几层转义。 */
  export const blobs: Record<string, string>

  /** 本次程序的 input 参数（任意 JSON 值），没给是 undefined。 */
  export const input: any
}
