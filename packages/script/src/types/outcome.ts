import type { ModelImage } from '@velaros-ai/kernel'

import type { ScriptExecutionMetrics, ScriptOutputCapture } from './output.js'
import type { CodeProgramCheckFailure, CodeProgramResult, CompletedCall } from './script.js'

/** 图像合同沿 Kernel、Script 与 Model 原样传递。 */
export type CodeAttachment = ModelImage

/** 检查结果与已执行程序的结果、图像及调用事实。 */
export type CodeSurfaceOutcome =
  | { checked: false; check: CodeProgramCheckFailure }
  | {
      /** typecheck 没走到：程序 import 了没授权的模块。 */
      checked: false
      /** 没授权的命名空间，按程序里出现的顺序；只有名字，不附签名。 */
      needsModules: string[]
    }
  | {
      checked: true
      result: CodeProgramResult
      /** 展示裁剪之前的原始输出，受独立归档上限约束。 */
      output?: ScriptOutputCapture
      /** 命名图片块对应的原生附件序号。 */
      outputAttachments?: ReadonlyArray<{ readonly key: string; readonly index: number }>
      /** 没有显式 output 时的完整程序返回值。 */
      rawValue?: unknown
      /** 宿主计量的执行成本。 */
      metrics?: ScriptExecutionMetrics
      /**
       * 程序交给模型看的图，按交出的顺序。放在 `result` 旁边而不是里面：
       * `result` 是文字，受 `resultChars` 约束；图有自己的张数与体积上限，另算。
       */
      attachments?: readonly CodeAttachment[]
      /** 这次程序落定的全部能力调用（连着的同名同结果折成一条），宿主审计使用；不回给模型。没有调用就没有这一格。 */
      calls?: readonly CompletedCall[]
    }
