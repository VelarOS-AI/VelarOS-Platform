import type { FeaturesOperationContext } from '../contract/requires.js'
import type {
  FeatureDefinition,
  FeatureIdInput,
  FeatureInstallInput,
  FeatureLoaded,
  FeaturePathInput,
  FeatureSummary,
} from '../types/features.js'
import { featureGuide } from '../utils/guide.js'
import { featureIdentity, featurePath } from '../utils/identity.js'

/** @AgentView Feature 能力目录、按需加载和安装管理。用户显式选择表示本次任务要求；其余能力按调用策略发现。说明、工具实现与 npm 依赖由同一能力版本管理。 */
export interface FeaturesOperationsApi {
  /** @AgentView 查询原生 Feature 格式、Codex Skill 导入和宿主 SDK 规范。
   * @OperationEffect none
   */
  guide(ctx: FeaturesOperationContext): Promise<string>
  /** @AgentView 列出能力的用途、安装、启用和兼容状态。正文按需 load。
   * @OperationEffect none
   */
  list(ctx: FeaturesOperationContext): Promise<readonly FeatureSummary[]>
  /** @AgentView 按身份加载本轮可用能力的完整 Skill 说明和资源目录。新 npm 包从下一次程序执行生效。
   * @OperationEffect none
   */
  load(input: FeatureIdInput, ctx: FeaturesOperationContext): Promise<FeatureLoaded>
  /** @AgentView 静态校验 Feature、Codex Skill 或 Markdown；不执行来源代码、不安装依赖。
   * @OperationEffect none
   */
  validate(input: FeaturePathInput, ctx: FeaturesOperationContext): Promise<FeatureDefinition>
  /** @AgentView 安装或升级本机来源，发布前由宿主确认；依赖脚本默认关闭。
   * @OperationEffect write
   * @OperationModes execute
   */
  install(input: FeatureInstallInput, ctx: FeaturesOperationContext): Promise<FeatureSummary>
  /** @AgentView 卸载能力并撤销后续调用；在途执行及后台任务持有的文件继续受租约保护。
   * @OperationEffect write
   * @OperationModes execute
   */
  remove(input: FeatureIdInput, ctx: FeaturesOperationContext): Promise<void>
}

/** 产品能力管理与执行协议共用宿主授权和效果回执。 */
class FeaturesOperations implements FeaturesOperationsApi {
  public async guide(ctx: FeaturesOperationContext): Promise<string> {
    ctx.abortSignal.throwIfAborted()
    return featureGuide
  }
  public async list(ctx: FeaturesOperationContext): Promise<readonly FeatureSummary[]> {
    ctx.abortSignal.throwIfAborted()
    return (await ctx.features.list()).map((feature) => ({
      ...feature,
      selected: !!ctx.features.selection?.some(
        (item) => item.id === feature.id && item.generation === feature.generation
      ),
    }))
  }
  public async load(input: FeatureIdInput, ctx: FeaturesOperationContext): Promise<FeatureLoaded> {
    ctx.abortSignal.throwIfAborted()
    return ctx.features.load({ id: featureIdentity(input) }, ctx.abortSignal)
  }
  public async validate(
    input: FeaturePathInput,
    ctx: FeaturesOperationContext
  ): Promise<FeatureDefinition> {
    ctx.abortSignal.throwIfAborted()
    return ctx.features.validate({ path: featurePath(input) }, ctx.abortSignal)
  }
  public async install(
    input: FeatureInstallInput,
    ctx: FeaturesOperationContext
  ): Promise<FeatureSummary> {
    ctx.recordEffect('none')
    await this.validate(input, ctx)
    await ctx.authorize('install', input, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    ctx.recordEffect('unknown')
    const result = await ctx.features.install(input, ctx.abortSignal)
    ctx.recordEffect('committed')
    return result
  }
  public async remove(input: FeatureIdInput, ctx: FeaturesOperationContext): Promise<void> {
    ctx.recordEffect('none')
    featureIdentity(input)
    await ctx.authorize('remove', input, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    ctx.recordEffect('unknown')
    await ctx.features.remove(input, ctx.abortSignal)
    ctx.recordEffect('committed')
  }
}

/** 统一能力模型操作的无状态实现。 */
export const featuresOperations: FeaturesOperationsApi = new FeaturesOperations()
