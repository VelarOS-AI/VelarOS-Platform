import type { ModuleBinding } from '@velaros-ai/kernel'

import type { RuntimeSessionBinding } from '../contract/requires.js'

/** 已固定的会话执行事实；控制读取不代表重新挂载其中的模块。 */
export interface SessionBindingDocument extends RuntimeSessionBinding {
  readonly version: 1
  readonly modules: readonly ModuleBinding[]
}
