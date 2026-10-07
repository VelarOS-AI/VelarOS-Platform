/** 浏览器外部模型传输与本机任务服务的独立 wire 身份。 */
export const ScriptActBridge = Object.freeze({
  service: 'velaros-scriptact-bridge',
  /** wire 主版本。 */
  version: 1,
  platform: '0.6',
  revision: '2026-10-07.1',
  path: '/v1/scriptact/ws',
  /** 本地端口扫描起点。 */
  portStart: 43137,
  /** 本地端口扫描终点。 */
  portEnd: 43147,
  /** 完整消息的 UTF-8 字节上限。 */
  maxMessageBytes: 16 * 1024 * 1024,
  /** 完整模型正文的字符上限。 */
  maxResponseChars: 2 * 1024 * 1024,
  /** 每张图像的保守输入容量预留。 */
  imageTokens: 8000,
  /** 等待单次网页模型的最长毫秒数。 */
  requestTimeoutMs: 30 * 60 * 1000,
})
