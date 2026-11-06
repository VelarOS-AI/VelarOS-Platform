// 搜索结果里的唯一片段可以直接提交，无需先读整份文件。
import { commit, inspect, undo } from 'velaros:project'

async function replaceOnce(path = 'src/config.ts', oldText = 'const retries = 3', newText = 'const retries = 5') {
  return commit({ changes: [{ path, oldText, newText }] })
}

// 一次读取同时提供计算输入和 before。Node readFile 的 Buffer 可以直接作为基线。
// 文本字符串作为基线按 UTF-8 字节核对；其他编码用原始 Buffer 或其 SHA-256。
async function commitFiles(changes) {
  return commit({ changes })
}

// 未收到回执时查当前会话在同一项目的最近事务；并行任务可指定 requestId。
async function inspectLatest() { return inspect({}) }
// 撤回回执带 status、changed、changedFiles、反向 diff 与 diffTruncated，按回执确认结果。
// 冲突会点明路径，保留用户后续修改；重复撤回 changed:false、alreadyUndone:true。
async function revert(changeRef) { return undo({ changeRef }) }
