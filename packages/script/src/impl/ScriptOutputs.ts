import type {
  ScriptOutputCapture,
  ScriptOutputEdit,
  ScriptOutputManifest,
  ScriptOutputProjection,
  ScriptOutputSummary,
} from '../types/output.js'
import type { CodeProgramRequest } from '../types/script.js'
import { outputContentHash, projectOutputs } from '../utils/output-render.js'
import { describeOutputSource, editOutputSource } from '../utils/output-source.js'

/** 输出声明、受限源码编辑和无副作用展示的唯一宿主端口。 */
export interface ScriptOutputsApi {
  /** 提取可静态管理的输出声明。 */
  describe(program: CodeProgramRequest): ScriptOutputManifest
  /** 仅改写展示字段，不运行脚本。 */
  edit(program: CodeProgramRequest, edit: ScriptOutputEdit): CodeProgramRequest
  /** 对已归档的原值重新展示，不访问外部能力。 */
  project(
    capture: ScriptOutputCapture,
    ref: string,
    maxChars: number,
    manifest?: ScriptOutputManifest,
    summaries?: readonly ScriptOutputSummary[],
    taskRevision?: string
  ): ScriptOutputProjection
  /** 对原始值计算稳定内容指纹。 */
  hash(value: unknown): string
}

/** 与 ScriptAct 共用脚本契约，不创建第二套运行器。 */
class ScriptOutputs implements ScriptOutputsApi {
  public describe(program: CodeProgramRequest): ScriptOutputManifest {
    return describeOutputSource(program)
  }
  public edit(program: CodeProgramRequest, edit: ScriptOutputEdit): CodeProgramRequest {
    return editOutputSource(program, edit)
  }
  public project(
    capture: ScriptOutputCapture,
    ref: string,
    maxChars: number,
    manifest?: ScriptOutputManifest,
    summaries?: readonly ScriptOutputSummary[],
    taskRevision?: string
  ): ScriptOutputProjection {
    return projectOutputs(capture, ref, maxChars, manifest, summaries, taskRevision)
  }
  public hash(value: unknown): string {
    return outputContentHash(value)
  }
}

/** 受信宿主共享的无状态输出服务。 */
export const scriptOutputs: ScriptOutputsApi = new ScriptOutputs()
