import { stringifyPretty } from '@velaros-ai/core'

import { VelarosCliEnvelope, VelarosCliExitCodes } from '../contract/constants.js'
import type {
  VelarosCliErrorEnvelope,
  VelarosCliNamespaceRunResult,
  VelarosCliSuccessEnvelope,
} from '../types/cli.js'
import type { VelarosCliSuccessInput } from '../types/output.js'

import type { VelarosCliError } from './errors.js'

/** 造一条成功结果：信封原样带着，文本按带没带 `--json` 二选一。 */
export function buildSuccessResult(input: VelarosCliSuccessInput): VelarosCliNamespaceRunResult {
  const envelope: VelarosCliSuccessEnvelope = {
    schemaVersion: VelarosCliEnvelope.schemaVersion,
    kind: `velaros.cli.${input.namespace}.${input.command}`,
    status: 'ok',
    namespace: input.namespace,
    command: input.command,
    cwd: input.cwd,
    durationMs: input.durationMs,
    result: input.result,
  }

  return {
    envelope,
    text: input.json
      ? `${stringifyPretty(envelope)}\n`
      : ensureTrailingNewline(input.text ?? stringifyPretty(input.result)),
    exitCode: input.exitCode ?? VelarosCliExitCodes.ok,
  }
}

/** 造一条失败结果：`--json` 给整个失败信封，否则给「错误码: 中文说明」一行。 */
export function buildErrorResult(
  error: VelarosCliError,
  json: boolean,
): VelarosCliNamespaceRunResult {
  const envelope: VelarosCliErrorEnvelope = {
    schemaVersion: VelarosCliEnvelope.schemaVersion,
    kind: VelarosCliEnvelope.errorKind,
    status: 'error',
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  }

  return {
    envelope,
    text: json ? `${stringifyPretty(envelope)}\n` : `${error.code}: ${error.message}\n`,
    exitCode: error.exitCode,
  }
}

/** 根帮助的文本：把当前注册着的命名空间逐行列出来，产品注册的也在里面。 */
export function buildRootHelpText(namespaces: readonly string[]): string {
  const lines = namespaces.map((namespace) => `  ${namespace} ...`)

  return `VelarOS 命令行

用法：
  velaros <命名空间> [参数...]

命令：
  help
${lines.join('\n')}

产品可以用 createVelarosCliRouter() 注册自己的运维命名空间；本包不扫 PATH，也不自动发现命令。
`
}

/** 补上结尾的换行：命令输出一律以换行收尾。 */
function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}
