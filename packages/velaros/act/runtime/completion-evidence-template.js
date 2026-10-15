// 仅完成复核会话提供 retrieve；原生工具名为 retrieve_evidence，同一生成合同与只读入口。
import { retrieve } from 'velaros:completion-evidence'
async function inspect(identity, literal) {
  return retrieve({ queries: [{ kind: 'find', identity, literal, limit: 4 }] })
}
async function readRange(identity, offset = 0, limit = 4000) {
  return retrieve({ queries: [{ kind: 'read', identity, offset, limit }] })
}
// 仅引用结果中实际出现的连续 text；nextOffset 用于续读，sha256 绑定整个原文，issue 保留缺口。
