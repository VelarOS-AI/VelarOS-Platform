// 长期指令的读写：directive:* 三个工具的 execute 交给它，宿主的指令面也用同一份判定。
import type { ActiveContextArtifact, ActiveContextArtifactStatus, ActiveDirectiveArchiveInput, ActiveDirectiveUpsertInput } from '../../types/agent'
import type { ActiveDirectiveArchiveResult, ActiveDirectiveContext } from '../../types/builtin'
import { archiveActiveDirectives, isActiveDirectiveArtifact, listActiveDirectives, upsertActiveDirective } from '../../utils/builtin/directives'

/**
 * 长期指令（上下文保护区里的 requirement 产物）的读写面。
 *
 * 指令是「一直生效」的用户约定，与目标、计划不同轴；条数上限在 `AgentToolLimits`。
 * 所有读写都经调用方给的活动上下文口，本类自己不持有任何状态。
 */
export interface DirectiveOperationsApi {
  /** 列出当前的长期指令；缺省只列活动的。 */
  list(context: ActiveDirectiveContext, status?: ActiveContextArtifactStatus | 'all'): Promise<ActiveContextArtifact[]>
  /** 新增或改写一条长期指令；到上限时按错误码拒绝。 */
  upsert(context: ActiveDirectiveContext, input: ActiveDirectiveUpsertInput): Promise<ActiveContextArtifact>
  /** 归档一批长期指令，让它们不再进提示词。 */
  archive(context: ActiveDirectiveContext, input: ActiveDirectiveArchiveInput): Promise<ActiveDirectiveArchiveResult>
  /** 判断一条活动上下文产物是不是长期指令。 */
  isDirective(artifact: ActiveContextArtifact): boolean
}

/** 方法逐个转调 utils/builtin/directives 里的纯函数；这里只负责把它们收成一件对外能力。 */
class DirectiveOperations implements DirectiveOperationsApi {
  public list(context: ActiveDirectiveContext, status?: ActiveContextArtifactStatus | 'all'): Promise<ActiveContextArtifact[]> {
    return listActiveDirectives(context, status)
  }

  public upsert(context: ActiveDirectiveContext, input: ActiveDirectiveUpsertInput): Promise<ActiveContextArtifact> {
    return upsertActiveDirective(context, input)
  }

  public archive(context: ActiveDirectiveContext, input: ActiveDirectiveArchiveInput): Promise<ActiveDirectiveArchiveResult> {
    return archiveActiveDirectives(context, input)
  }

  public isDirective(artifact: ActiveContextArtifact): boolean {
    return isActiveDirectiveArtifact(artifact)
  }
}

/** 长期指令的读写面（无状态，进程内共用一份）。 */
export const directiveOperations: DirectiveOperationsApi = new DirectiveOperations()
