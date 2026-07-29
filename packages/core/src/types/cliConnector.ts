/**
 * 外部 CLI 连接器目录（catalog）线型。
 *
 * 主进程按探针结果 + 安装进度合成一份 catalog 推给设置页；
 * 设置页把每个连接器渲染成一张卡片（未安装可引导安装、未鉴权可去配置、已就绪显示状态）。
 */

/** 连接器就绪状态。checking 表示探针尚未返回（正在检测）。 */
export type CliConnectorStatus = 'checking' | 'ready' | 'unauthenticated' | 'missing' | 'error'

/** 安装进行中/失败态（引导安装期间由主进程推送）。 */
export interface CliConnectorInstallState {
  phase: 'installing' | 'failed'
  /** 正在执行的安装命令，用于展示。 */
  command?: string
  /** 失败原因文本。 */
  error?: string
}

/** 安装/鉴权引导里的一条命令。 */
export interface CliConnectorSetupCommand {
  label: string
  command: string
}

/** 安装或鉴权引导步骤。 */
export interface CliConnectorSetupStep {
  title: string
  description?: string
  commands?: CliConnectorSetupCommand[]
  documentationUrl?: string
  nextSteps?: string[]
}

/** 单个连接器的目录记录。 */
export interface CliConnectorRecord {
  id: string
  name: string
  executable: string
  toolName: string
  description: string
  status: CliConnectorStatus
  installed: boolean
  authed: boolean
  /** version 命令输出的首行，便于展示版本。 */
  versionLabel?: string
  /** 该连接器有无鉴权检查；无检查时不展示鉴权状态。 */
  hasAuthCheck: boolean
  /** 上游/文档链接。 */
  upstreamUrl?: string
  /** 探针错误文本。 */
  error?: string
  /** 安装进行中/失败态。 */
  install?: CliConnectorInstallState
  /** 平台匹配后可一键执行的安装命令；无匹配则为空。 */
  installCommand?: string
  /** 安装引导（命令 + 文档）。 */
  setupInstall?: CliConnectorSetupStep
  /** 鉴权引导（命令 + 文档）。 */
  setupAuth?: CliConnectorSetupStep
  capabilities?: string[]
}

/** 连接器目录。 */
export interface CliConnectorCatalog {
  generatedAt: number
  connectors: CliConnectorRecord[]
}
