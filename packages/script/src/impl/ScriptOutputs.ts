import type {
  ScriptOutputCapture,
  ScriptOutputDisplay,
  ScriptOutputEdit,
  ScriptOutputFormat,
  ScriptOutputManifest,
  ScriptOutputProjection,
  ScriptOutputSummary,
} from '../types/output.js'
import type { CodeProgramRequest } from '../types/script.js'
import {
  outputContentHash,
  projectOutputs,
  requestOutputBudget,
  withoutOutputBodies,
} from '../utils/output-render.js'
import { describeOutputSource, editOutputSource } from '../utils/output-source.js'

/** 输出声明、受限源码编辑和无副作用展示的唯一宿主端口。 */
export interface ScriptOutputsApi {
  /** 推导展示申请：显式整体预算优先，否则计入有效块申请的实际编码；宿主份额仍是硬上限。ref 用于精确计量引用目录。 */
  requestBudget(
    capture: ScriptOutputCapture,
    manifest?: ScriptOutputManifest,
    ref?: string
  ): { maxChars: number; explicit: boolean }
  /** 提取可静态管理的输出声明。 */
  describe(program: CodeProgramRequest): ScriptOutputManifest
  /** 仅改写展示字段，不运行脚本。 */
  edit(program: CodeProgramRequest, edit: ScriptOutputEdit): CodeProgramRequest
  /** 对已归档的原值重新展示；默认 JSON；text 按实际正文与目录总长独立分配同一上限。 */
  project(
    capture: ScriptOutputCapture,
    ref: string,
    maxChars: number,
    manifest?: ScriptOutputManifest,
    summaries?: readonly ScriptOutputSummary[],
    taskRevision?: string,
    format?: ScriptOutputFormat,
    displays?: readonly ScriptOutputDisplay[]
  ): ScriptOutputProjection
  /** 宿主确认正文已在同一请求其他位置交付后，按块身份保留引用；可选上限只缩减现有份额，计入同一编码的元数据，放不下的块明确省略。 */
  withoutBodies(
    projection: ScriptOutputProjection,
    identities: ReadonlyArray<{ key: string; contentHash: string }>,
    maxChars?: number
  ): ScriptOutputProjection
  /** 对原始值计算稳定内容指纹。 */
  hash(value: unknown): string
}

/** 与 ScriptAct 共用脚本契约，不创建第二套运行器。 */
class ScriptOutputs implements ScriptOutputsApi {
  public requestBudget(
    capture: ScriptOutputCapture,
    manifest?: ScriptOutputManifest,
    ref?: string
  ): { maxChars: number; explicit: boolean } {
    return requestOutputBudget(capture, manifest, ref)
  }
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
    taskRevision?: string,
    format?: ScriptOutputFormat,
    displays?: readonly ScriptOutputDisplay[]
  ): ScriptOutputProjection {
    return projectOutputs(
      capture,
      ref,
      maxChars,
      manifest,
      summaries,
      taskRevision,
      format,
      displays
    )
  }
  public withoutBodies(
    projection: ScriptOutputProjection,
    identities: ReadonlyArray<{ key: string; contentHash: string }>,
    maxChars?: number
  ): ScriptOutputProjection {
    return withoutOutputBodies(projection, identities, maxChars)
  }
  public hash(value: unknown): string {
    return outputContentHash(value)
  }
}

/** 受信宿主共享的无状态输出服务。 */
export const scriptOutputs: ScriptOutputsApi = new ScriptOutputs()
