/**
 * 命令输出交给程序之前的脱敏：跑命令与在镜像里跑命令用同一条路。
 */

import { isString } from '@velaros-ai/core'
import type { ShellCommandResult } from '@velaros-ai/velar/shell/contracts'

import type { ProjectCallContext } from '../../contract/requires.js'

/**
 * 命令输出交给程序之前过一遍项目的脱敏后端：跑命令与在镜像里跑命令用同一条路，
 * 不然「在沙箱里 cat 一个私钥」就成了绕开项目读取治理的后门。宿主没有脱敏后端时原样返回。
 */
export async function redactCommandOutput<T>(context: ProjectCallContext, result: T): Promise<T> {
  const output = result as Partial<ShellCommandResult>
  if (!isString(output?.stdout) && !isString(output?.stderr)) return result
  const kernel = await context.project.kernel()
  const stdout = isString(output.stdout) ? (await kernel.redactText({ content: output.stdout })).content : output.stdout
  const stderr = isString(output.stderr) ? (await kernel.redactText({ content: output.stderr })).content : output.stderr
  return { ...result, stdout, stderr }
}
