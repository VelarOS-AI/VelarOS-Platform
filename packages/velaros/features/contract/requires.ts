import type {
  FeatureDefinition,
  FeatureIdInput,
  FeatureInstallInput,
  FeatureLoaded,
  FeaturePathInput,
  FeatureSelection,
  FeatureSummary,
} from '../types/features.js'

/** 产品提供唯一能力库；资源绑定、安装分发和选择授权由宿主持有。 */
export interface FeatureHost {
  /** 用户本次任务明确选择的安装与授权快照。 */
  readonly selection?: readonly FeatureSelection[]
  /** 查询当前产品能力及兼容状态。 */
  list(): Promise<readonly FeatureSummary[]>
  /** 在本轮固定目录里加载知识和依赖。 */
  load(input: FeatureIdInput, signal: AbortSignal): Promise<FeatureLoaded>
  /** 只做静态格式和资源检查。 */
  validate(input: FeaturePathInput, signal: AbortSignal): Promise<FeatureDefinition>
  /** 完成依赖准备后原子发布能力。 */
  install(input: FeatureInstallInput, signal: AbortSignal): Promise<FeatureSummary>
  /** 撤销后续调用资格，保留在途执行持有的文件。 */
  remove(input: FeatureIdInput, signal: AbortSignal): Promise<void>
}

/** 本轮宿主上下文；模型提供的文本不能改变授权策略。 */
export interface FeaturesOperationContext {
  /** 绑定本轮会话和工作目录的能力库。 */
  readonly features: FeatureHost
  /** 当前调用的取消信号。 */
  readonly abortSignal: AbortSignal
  /** 管理写入在副作用发生前经过宿主确认。 */
  authorize(
    operation: 'install' | 'remove',
    input: FeatureInstallInput | FeatureIdInput,
    signal: AbortSignal
  ): Promise<void>
  /** 写入效果进入父调用的实际回执。 */
  recordEffect(effect: 'none' | 'unknown' | 'committed'): void
}
