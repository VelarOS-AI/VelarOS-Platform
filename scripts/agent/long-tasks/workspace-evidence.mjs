// 清理前保存最终 Git 差量和全部未跟踪文件，不依赖源码扩展名白名单。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export async function preserveWorkspaceEvidence(workspace, output, baseline, options = {}) {
  const { signal, beforeWrite } = options
  signal?.throwIfAborted()
  const git = async (...args) =>
    (
      await execute('git', args, {
        cwd: workspace,
        maxBuffer: 32_000_000,
        encoding: 'buffer',
        signal,
      })
    ).stdout
  const directory = join(output, 'source-evidence')
  const patch = await git('diff', '--binary', '--no-ext-diff', baseline, '--')
  const names = (await git('ls-files', '--others', '--exclude-standard', '-z'))
    .toString()
    .split('\0')
    .filter(Boolean)
  const planned = []
  let bytes = patch.byteLength + 4096
  for (const name of names) {
    signal?.throwIfAborted()
    const source = resolve(workspace, name)
    if (!source.startsWith(resolve(workspace) + sep))
      throw new Error('Evidence path escapes workspace')
    const stat = await lstat(source)
    const target = stat.isSymbolicLink() ? await readlink(source) : undefined
    if (!stat.isSymbolicLink() && !stat.isFile())
      throw new Error('Unsupported source evidence entry')
    planned.push({ name, source, stat, target })
    // 文件内容、差量及清单都进入预留；忽略的缓存和已有源码不再次算作证据副本。
    bytes +=
      (stat.isFile() ? stat.size : 0) + Buffer.byteLength(JSON.stringify([name, target])) + 256
  }
  await beforeWrite?.(bytes)
  signal?.throwIfAborted()
  await mkdir(directory)
  await writeFile(join(directory, 'tracked.patch'), patch)
  const files = []
  for (const { name, source, stat, target } of planned) {
    signal?.throwIfAborted()
    if (stat.isSymbolicLink()) files.push({ path: name, type: 'symlink', target })
    else {
      const destination = join(directory, 'files', name)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination, constants.COPYFILE_FICLONE)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(destination, { signal })) hash.update(chunk)
      files.push({
        path: name,
        type: 'file',
        bytes: stat.size,
        mode: stat.mode & 0o777,
        sha256: hash.digest('hex'),
      })
    }
  }
  const manifest = {
    baseline,
    head: (await git('rev-parse', 'HEAD')).toString().trim(),
    trackedPatchSha256: createHash('sha256').update(patch).digest('hex'),
    files,
  }
  signal?.throwIfAborted()
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
