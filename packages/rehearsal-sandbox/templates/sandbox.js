// velar:sandbox 的代码模版：挑一段照着改，import 只写一次。
// 镜像里的命令写不到镜像外；落回源目录之前一定会先问用户。
import { apply, create, diff, discard, run } from 'velar:sandbox'

// 在镜像里试一条会改文件的命令，看它到底改了什么；失败就把镜像丢掉。
async function tryInMirror(source = '~/project', command = 'npx prettier --write src') {
  const box = await create({ source })
  const result = await run({ id: box.id, command })
  if (!result.success) {
    await discard({ id: box.id })
    return { failed: true, exitCode: result.exitCode, tail: result.stderr.slice(-2000) }
  }
  const changes = await diff({ id: box.id })
  return { id: box.id, created: changes.created, modified: changes.modified, deleted: changes.deleted }
}

// 上一轮看过差量、决定落回：只落指定的几个文件。
async function applySome(id = 'create 返回的 id', paths = ['src/index.ts']) {
  return apply({ id, paths })
}

export default await tryInMirror()
