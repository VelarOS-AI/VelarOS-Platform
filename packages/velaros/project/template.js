// 普通读写、遍历与搜索使用 Node、globby、ripgrep；只有需要事务、冲突保护或撤回时才用本模块。
// Node 已读的完整原文直接传 expectedText；不必额外 read/select，也不需要手工管理版本号。
import { edit, inspect, patch, select, undo } from 'velaros:project'

// 一处精确替换：oldText 要唯一，其他位置的外部改动保留；不需要先 select。
async function replaceOnce(path = 'src/config.ts', oldText = 'const retries = 3', newText = 'const retries = 5') {
  return edit({ steps: [{ action: 'replace', path, oldText, newText }] })
}

// 原文由 Node readFile 等方式取得，在程序内计算新正文；空串表示空文件，null 表示只允许新建。
// expectedText 比对完整解码正文（可带开头 BOM，换行原样）；不匹配时整批拒绝，重新读取合并。
/** @param {string|null} expectedText */
async function safelyWriteFile(path = 'src/config.ts', expectedText = 'const retries = 3\n', text = 'const retries = 5\n') {
  return edit({ steps: [{ action: 'write', path, expectedText, text }] })
}

// 多文件只提交一次。读取或计算任一文件失败时停止，不能把成功子集作为整批提交。
// files: [{path, before: 已读完整原文或null, after: 新正文}]；不在这里重复读取或申请编辑引用。
async function commitFiles(files) {
  if (!files.length) return { changed: false, changedFiles: [] }
  return edit({ steps: files.map(({ path, before, after }) => ({
    action: 'write', path, expectedText: before, text: after,
  })) })
}

// 新建模块和修改引用一起提交；已有同名文件时拒绝覆盖。
async function addModule(importer = 'src/index.ts', path = 'src/cache.ts', firstLine = "import { load } from './load.js'") {
  return edit({ steps: [
    { action: 'write', path, expectedText: null, text: 'export const cache = new Map()\n' },
    { action: 'replace', path: importer, oldText: firstLine, newText: `${firstLine}\nimport { cache } from './cache.js'` },
  ] })
}

// 改名与正文替换在同一事务中，后一步使用前一步的结果。
async function renameFile(path = 'src/old-name.ts', to = 'src/new-name.ts', oldName = 'class OldName', newName = 'class NewName') {
  return edit({ steps: [
    { action: 'move', path, to },
    { action: 'replace', path: to, oldText: oldName, newText: newName },
  ] })
}

// 需要完整差量时再查看；无需每次提交后额外调用。
async function review(changeRef) { return inspect({ changeRef }) }

// 按回执整次撤回；之后有外部修改时拒绝覆盖，已经撤回时幂等成功。
async function revert(changeRef) { return undo({ changeRef }) }

// 高级用法：只有需要按结构精确定位、或减少大段原文传输时才 select + patch。
async function rewriteSymbol(path = 'src/cache.py', symbol = 'Cache.load', text = '    def load(self, key):\n        return self.items.get(key)') {
  const found = await select({ targets: [{ path, symbol }] })
  if (found.issues?.length) return found
  return patch({ edits: [{ target: found.targets[0].target, text }] })
}

// 大批结构编辑的失败计划可按原下标修正；普通编辑不需要建立这套流程。
async function amendPatch(planRef, index, edit) {
  return patch({ planRef, amendments: [{ index, edit }] })
}
