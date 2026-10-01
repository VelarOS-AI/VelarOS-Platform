import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// 封印实际进入候选的文件；安装缓存和封印本身不参与递归。
export async function createBundleSeal(root) {
  const filesSha256 = {}
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' && entry.isDirectory()) continue
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (name === 'identity.json') continue
      if (entry.isSymbolicLink()) throw new Error(`Bundle contains symlink: ${name}`)
      if (entry.isDirectory()) await visit(join(directory, entry.name), name)
      else if (entry.isFile())
        filesSha256[name] = createHash('sha256')
          .update(await readFile(join(directory, entry.name)))
          .digest('hex')
      else throw new Error(`Bundle contains unsupported entry: ${name}`)
    }
  }
  await visit(root, '')
  const ordered = Object.fromEntries(
    Object.entries(filesSha256).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    )
  )
  const hash = createHash('sha256')
  for (const [name, digest] of Object.entries(ordered))
    hash.update(name).update('\0').update(digest).update('\n')
  return { schemaVersion: 1, sha256: hash.digest('hex'), filesSha256: ordered }
}
