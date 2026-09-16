/**
 * 包内的工作类型：解析一个协议标签得到的结果、URL 构造器的最小形状、迷你日志的形状。
 * 都不出包——它们是实现自己的形状，不在任何公开签名里。
 */

/** 从一段 `<artifact …>` 或 `<patch …>` 原文里解出来的标签。 */
export interface ParsedProtocolTag {
  /** 标签原文，原样留着好回填进协议原文。 */
  raw: string
  /** 标签上的属性，键是属性名，值是去掉引号之后的原文。 */
  attributes: Record<string, string>
}

/** `URL` 实例里本包真正会读的两项。 */
export interface UrlLike {
  /** 归一化之后的完整地址。 */
  href: string
  /** 协议名，带结尾冒号。 */
  protocol: string
}

/** `URL` 构造器的最小形状：宿主环境没有它时就直接拒绝外链。 */
export interface UrlConstructorLike {
  /** 按一段文本造一个 URL；造不出来时按约定抛错。 */
  new (input: string): UrlLike
}

/** 迷你日志的形状：本包零运行时依赖，自带这一份，不引 core。 */
export interface HtmlArtifactRuntimeLog {
  /** 调试信息。 */
  debug: (message: string, context?: unknown) => void
  /** 错误信息。 */
  error: (message: string, context?: unknown) => void
  /** 警告信息。 */
  warn: (message: string, context?: unknown) => void
}
