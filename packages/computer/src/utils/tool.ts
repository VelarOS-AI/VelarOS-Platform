/** 定义桌面控制工具的小壳子：只补上固定的类别，其余按上游工具契约。 */

import { toolContracts } from '@velaros-ai/tool-contract'

import { ComputerToolCategoryId } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type {
  ComputerRuntimePort,
  ComputerToolComputerApi,
  ComputerToolContext,
} from '../contract/requires.js'
import type { DefineComputerToolInput } from '../types/tool.js'

/** 定义一个桌面控制工具：类别固定是 computer-control，上下文固定是 `ComputerToolContext`。 */
export const defineComputerTool: <TInput extends Record<string, unknown>>(
  input: DefineComputerToolInput<TInput>
) => VelaTool<TInput> = toolContracts.createDefiner<ComputerToolContext>({
  categoryOf: () => ComputerToolCategoryId,
})

/**
 * 把一份运行时薄映射成工具的宿主端口。
 *
 * 宿主没给上下文解析器、只注入了运行时时，内核挂载用它兜底；两个宿主各自写的映射也是同一份。
 * 端口比运行时窄：`screenSize`、`isReady`、`dispose` 是宿主自己界面的事，工具够不着。
 */
export function computerHostPortFromRuntime(
  runtime: ComputerRuntimePort
): ComputerToolComputerApi {
  return {
    ensureAvailable: () => runtime.ensureAvailable(),
    screenshot: () => runtime.screenshot(),
    mouseMove: (x, y, options) => runtime.mouseMove(x, y, options),
    click: (x, y, options) => runtime.click(x, y, options),
    typeText: (text) => runtime.typeText(text),
    key: (keys) => runtime.key(keys),
  }
}
