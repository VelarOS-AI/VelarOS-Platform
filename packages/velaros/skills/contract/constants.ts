/** 安装与发现的格式版本由收据显式记录。 */
export const SkillLimits = Object.freeze({
  /** 单次会话允许选择的 Skill 数量。 */
  selection: 64,
  /** 单份清单或声明最多读取的字节数。 */
  manifestBytes: 1024 * 1024,
  /** 单个安装文件的字节上限。 */
  fileBytes: 128 * 1024 * 1024,
  /** 单次安装全部文件的字节上限。 */
  totalBytes: 1024 * 1024 * 1024,
  /** 单次安装允许的目录条目数。 */
  files: 100_000,
  /** 每个 Skill 的宿主能力模块数。 */
  capabilities: 64,
  /** 每个 Skill 公开给 Agent 的 npm 包数量。 */
  packages: 256,
  /** 依赖安装的最长执行时间。 */
  installTimeoutMs: 300_000,
  /** 单次外部能力调用的最长执行时间。 */
  providerTimeoutMs: 60_000,
})
