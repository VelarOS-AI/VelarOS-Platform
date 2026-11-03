// 后台整理的有限时限与资源收尾。
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { VelarContextMaterialsModule } from '../../system/contract/surface.js'
import { MemoryConsolidationLimits } from '../contract/constants.js'
import type { MemoryConsolidationOptions } from '../contract/requires.js'
import type { MemoryConsolidationResult } from '../types/memory.js'
import { collectMemory } from '../utils/memory-consolidation.js'

/** 一次整理返回候选，写入由宿主队列统一提交。 */
export interface MemoryConsolidationApi {
  /** 有限轮次读取材料并交付待保存主题。 */
  run(options: MemoryConsolidationOptions): Promise<MemoryConsolidationResult>
}

class MemoryConsolidation implements MemoryConsolidationApi {
  public async run(options: MemoryConsolidationOptions): Promise<MemoryConsolidationResult> {
    const timers = new TimerScope({ name: 'MemoryConsolidation' })
    try {
      return await timers.withTimeout(
        MemoryConsolidationLimits.timeoutMs,
        (signal) => collectMemory(options, signal, VelarContextMaterialsModule),
        { signal: options.signal }
      )
    } finally {
      timers.dispose()
    }
  }
}

/** 创建一次知识整理的轻量执行器。 */
export function createMemoryConsolidation(): MemoryConsolidationApi {
  return new MemoryConsolidation()
}
