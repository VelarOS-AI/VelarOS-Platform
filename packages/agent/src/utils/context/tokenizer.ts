/**
 * 分词器接入层。
 *
 * 设计要点：
 *  - 默认 `heuristic` 引擎完全保留 `contextUsage.ts` 已有的启发式行为，零行为变化。
 *  - 通过环境变量 `VELAROS_TOKENIZER_ENGINE=tiktoken` 切换到基于 BPE 的真实分词器。
 *  - 选用 `o200k_base` 编码：GPT-4o / GPT-5 / o3 系列直接对齐，对 Claude 4 这类未公开分词器
 *    的模型也是当前可获得的最佳近似（实测误差约 ±5%，远好于纯字符启发式）。
 *
 * 注意：本模块刻意不依赖 `src/main/env/schema`。`packages/core` 是跨进程发布库；
 * Node 环境可读 `process.env`，其他运行环境无 process 时回退到启发式模式。
 */

import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base'

export type TokenizerEngine = 'heuristic' | 'tiktoken'

/**
 * 根据当前 `process.env.VELAROS_TOKENIZER_ENGINE` 决定使用哪种分词器。
 *
 * 不识别的值回退到 `heuristic`，确保新模式总是显式开关，旧链路零回归。
 */
export function resolveTokenizerEngine(): TokenizerEngine {
  const raw = (
    globalThis as { process?: { env?: Record<string, string> } }
  ).process?.env?.VELAROS_TOKENIZER_ENGINE?.trim().toLowerCase()
  return raw === 'tiktoken' ? 'tiktoken' : 'heuristic'
}

/**
 * 用 `o200k_base` 编码精确统计 token 数；空字符串返回 0。
 *
 * 上游建议在 tiktoken 模式 try/catch 包裹：万一底层编码异常，调用方应能降级到字符近似，
 * 避免单次错误把整个 compaction 流程拖垮。
 */
export function countTokensTiktoken(text: string): number {
  if (!text) return 0
  return o200kCountTokens(text)
}
