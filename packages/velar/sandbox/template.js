// velar:sandbox 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 会改一批文件的命令（格式化、批量替换、迁移脚本）先在镜像里跑：看过差量再落回，不满意就丢掉，源目录一个字节都不动。
import { apply, create, diff, discard, run } from 'velar:sandbox'

// 在镜像里试一条命令，看它改了哪些文件；命令失败就把镜像丢掉。镜像留着，看完差量再决定落不落回。
async function rehearse(command = 'npx prettier --write src', source = '.') {
  const box = await create({ source })
  const result = await run({ id: box.id, command })
  if (!result.success) {
    await discard({ id: box.id })
    return { failed: true, exitCode: result.exitCode, tail: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-30).join('\n') }
  }
  const changes = await diff({ id: box.id })
  return { id: box.id, created: changes.created, modified: changes.modified, deleted: changes.deleted }
}

// 看某几个文件具体改成了什么：textDiffs 是统一差量，不给 paths 就是全部。
async function showChanges(id = 'rehearse 交回的 id', paths = ['src/index.ts']) {
  const { textDiffs } = await diff({ id, paths })
  return textDiffs.map((file) => `── ${file.path}\n${file.diff}`).join('\n')
}

// 看过没问题就落回：给 paths 只落那几个，不给就全部落。落完把镜像丢掉。
async function applyAndClean(id = 'rehearse 交回的 id', paths = ['src/index.ts']) {
  const applied = await apply({ id, paths })
  await discard({ id })
  return applied
}

// 在镜像里装依赖、重新构建：gitignore 忽略的目录（node_modules 这类）复制进来，再打开网络；试完就丢，源目录不动。
async function rehearseBuild(command = 'npm install && npm run build', source = '.') {
  const box = await create({ source, ignored: 'copy', network: true })
  const result = await run({ id: box.id, command, timeoutMs: 600000 })
  await discard({ id: box.id })
  return { success: result.success, tail: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-30).join('\n') }
}

// 不要了：丢掉镜像，源目录不受影响；本来就不在也不算错。
async function throwAway(id = 'rehearse 交回的 id') {
  return discard({ id })
}
