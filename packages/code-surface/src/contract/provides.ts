/** 对外合同的产品面：交出去的整件能力。类实现的 API 定义在类上方，这里 re-export 登记；没有类的公开接口（工具集合、能力服务）直接声明在这里。 */

import type { ToolPermission } from '@velaros-ai/agent/contracts'
import type { ToolContractRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel'

import type { CodeSurfaceToolName } from './constants.js'
import type { CodeSurfaceToolContext } from './requires.js'

export type { CodeProgramCheckerApi } from '../impl/CodeProgramChecker.js'
export type { CodeProgramGateApi } from '../impl/CodeProgramGate.js'
export type { CodeSurfaceSessionApi } from '../impl/CodeSurfaceSession.js'

/** 门的一个工具的运行时规格：模型看到的说明、入参 schema、权限、能力声明与 execute；上下文是宿主注入的 `CodeSurfaceToolContext`。 */
export type CodeSurfaceTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, CodeSurfaceToolContext, unknown, ToolPermission>

/** 门在模型面上的工具，按工具名索引（`script:exec`、`script:history`、`script:show`、`script:diff`），实例是 `codeSurfaceTools`。 */
export type CodeSurfaceToolCollection = Readonly<Record<CodeSurfaceToolName, CodeSurfaceTool<any>>>

/** 门的能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `CodeSurfaceCapability`；宿主经内核按工具名调用它。 */
export interface CodeSurfaceCapabilityService extends KernelCallableCapabilityService {
  /** 门的工具，给只想读工具说明的宿主用。 */
  readonly tools: CodeSurfaceToolCollection
}
