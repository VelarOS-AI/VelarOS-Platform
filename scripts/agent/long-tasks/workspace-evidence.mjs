// 清理前保存最终 Git 差量和全部未跟踪文件，不依赖源码扩展名白名单。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export async function preserveWorkspaceEvidence(workspace, output, baseline) {
  const git = async (...args) =>
    (await execute('git', args, { cwd: workspace, maxBuffer: 32_000_000, encoding: 'buffer' }))
      .stdout
  const directory = join(output, 'source-evidence')
  await mkdir(directory)
  const patch = await git('diff', '--binary', '--no-ext-diff', baseline, '--')
  await writeFile(join(directory, 'tracked.patch'), patch)
  const names = (await git('ls-files', '--others', '--exclude-standard', '-z'))
    .toString()
    .split('\0')
    .filter(Boolean)
  const files = []
  for (const name of names) {
    const source = resolve(workspace, name)
    if (!source.startsWith(resolve(workspace) + sep))
      throw new Error('Evidence path escapes workspace')
    const stat = await lstat(source)
    if (stat.isSymbolicLink())
      files.push({ path: name, type: 'symlink', target: await readlink(source) })
    else if (stat.isFile()) {
      const destination = join(directory, 'files', name)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination, constants.COPYFILE_FICLONE)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(destination)) hash.update(chunk)
      files.push({
        path: name,
        type: 'file',
        bytes: stat.size,
        mode: stat.mode & 0o777,
        sha256: hash.digest('hex'),
      })
    } else throw new Error('Unsupported source evidence entry')
  }
  const manifest = {
    baseline,
    head: (await git('rev-parse', 'HEAD')).toString().trim(),
    trackedPatchSha256: createHash('sha256').update(patch).digest('hex'),
    files,
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
