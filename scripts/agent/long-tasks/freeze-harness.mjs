import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

// 冻结完整脚本树及其数据依赖；按扩展名筛选会遗漏运行时才加载的预加载器或夹具。
export async function freezeHarness(source, destination) {
  source = resolve(source)
  destination = resolve(destination)
  const nested = relative(source, destination)
  assert(
    nested === '..' || nested.startsWith(`..${sep}`),
    'Frozen harness destination must be outside its source tree'
  )
  const files = {}
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['__pycache__', 'node_modules', '.git'].includes(entry.name)) await collect(path)
        continue
      }
      assert(entry.isFile(), `Harness dependency must be a regular file: ${path}`)
      const target = join(destination, relative(source, path))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(path, target, constants.COPYFILE_EXCL)
      files[target] = createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
    }
  }
  await collect(source)
  return files
}
