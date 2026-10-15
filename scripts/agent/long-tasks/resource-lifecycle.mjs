// 评测独占资源的归属、空间预算、流式归档校验与回收；不扫描其他任务目录。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createGzip, createGunzip } from 'node:zlib'

import { createOwnedWorkspaceProcessGuard } from '../native-desktop/owned-processes.mjs'

const GiB = 1024 ** 3
const ownerName = '.evaluation-owner.json'
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function registerTaskResources(root, output, policy = {}) {
  root = await realpath(root)
  output = await realpath(output)
  assert(!output.startsWith(root + sep) && !root.startsWith(output + sep) && output !== root)
  assert.match(basename(root), /^vlr-[a-zA-Z0-9-]+$/u)
  assert(
    Object.keys(policy).every((key) => ['minFreeBytes', 'maxTaskBytes'].includes(key)),
    'Unknown storage policy'
  )
  const limits = { minFreeBytes: 2 * GiB, maxTaskBytes: 16 * GiB, ...policy }
  for (const value of Object.values(limits)) assert(Number.isSafeInteger(value) && value > 0)
  const stat = await lstat(root)
  const resource = {
    schema: 1,
    id: randomUUID(),
    root,
    output,
    dev: stat.dev,
    ino: stat.ino,
    limits,
  }
  await writeFile(join(root, ownerName), JSON.stringify(resource), { flag: 'wx', mode: 0o600 })
  await writeFile(join(output, 'resources.json'), JSON.stringify(resource, null, 2), {
    flag: 'wx',
    mode: 0o600,
  })
  return resource
}

async function owned(resource) {
  const stat = await lstat(resource.root)
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Task root must remain a real directory')
  assert.equal(await realpath(resource.root), resource.root)
  assert.equal(stat.dev, resource.dev)
  assert.equal(stat.ino, resource.ino)
  assert.deepEqual(await json(join(resource.root, ownerName)), resource, 'Resource owner changed')
  assert.deepEqual(await json(join(resource.output, 'resources.json')), resource)
}

// 只有登记为本次评测独占的工作区可以启用 cwd 回收；普通产品工作区不进入此边界。
export async function createTaskProcessGuard(resource, workspace, directory) {
  await owned(resource)
  workspace = await realpath(workspace)
  directory = await realpath(directory)
  assert(
    workspace === resource.root || workspace.startsWith(resource.root + sep),
    'Process scope must be inside owned task root'
  )
  assert(directory.startsWith(resource.output + sep), 'Cleanup receipt must belong to this run')
  return createOwnedWorkspaceProcessGuard({ workspace, directory, resourceId: resource.id })
}

export async function acquireTaskResources(resource) {
  await owned(resource)
  const path = join(resource.output, 'resources.lock')
  const handle = await open(path, 'wx', 0o600)
  const token = randomUUID()
  await handle.writeFile(
    JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })
  )
  await handle.close()
  return async () => {
    assert.equal((await json(path)).token, token)
    await rm(path)
  }
}

async function* entries(root, directory = root) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const stat = await lstat(path)
    const value = { path: relative(root, path).split(sep).join('/'), mode: stat.mode & 0o777 }
    if (stat.isSymbolicLink()) yield { ...value, type: 'symlink', target: await readlink(path) }
    else if (stat.isFIFO()) yield { ...value, type: 'fifo' }
    else if (stat.isDirectory()) {
      yield { ...value, type: 'directory' }
      yield* entries(root, path)
    } else {
      assert(stat.isFile(), `Unsettled special resource: ${value.path}`)
      yield { ...value, type: 'file', bytes: stat.size }
    }
  }
}

/** 运行中的临时文件可随时消失，socket 也可能仍在使用；计量不将其误判成归档失败。 */
async function directoryBytes(path, { filter, signal } = {}) {
  signal?.throwIfAborted()
  if (filter && !(await filter(path))) return 0
  signal?.throwIfAborted()
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isFile()) return stat.size
  if (!stat?.isDirectory()) return 0
  let bytes = 0
  const names = await readdir(path).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names) {
    signal?.throwIfAborted()
    bytes += await directoryBytes(join(path, name), { filter, signal })
  }
  return bytes
}

export async function checkTaskResourceBudget(
  resource,
  { additionalRootBytes = 0, additionalEvidenceBytes = 0, signal } = {}
) {
  signal?.throwIfAborted()
  for (const value of [additionalRootBytes, additionalEvidenceBytes])
    assert(Number.isSafeInteger(value) && value >= 0, 'Invalid projected storage growth')
  await owned(resource)
  const rootBytes = await directoryBytes(resource.root, { signal })
  const evidenceBytes = await directoryBytes(resource.output, { signal })
  const bytes = rootBytes + evidenceBytes
  const volume = await statfs(resource.root)
  const archiveVolume = await statfs(resource.output)
  const free = Math.min(volume.bavail * volume.bsize, archiveVolume.bavail * archiveVolume.bsize)
  const additionalBytes = additionalRootBytes + additionalEvidenceBytes
  // JSONL 归档含 base64 和逐项元数据；按未来任务根预留压缩前的保守余量。
  const archiveReserveBytes = Math.ceil((rootBytes + additionalRootBytes) * 1.5) + 8 * 1024 ** 2
  const projectedBytes = bytes + additionalBytes + archiveReserveBytes
  const requiredFreeBytes = resource.limits.minFreeBytes + additionalBytes + archiveReserveBytes
  signal?.throwIfAborted()
  assert(projectedBytes <= resource.limits.maxTaskBytes, 'Evaluation task storage limit exceeded')
  assert(free >= requiredFreeBytes, 'Insufficient free disk space for evaluation')
  return {
    bytes,
    rootBytes,
    evidenceBytes,
    free,
    additionalBytes,
    archiveReserveBytes,
    projectedBytes,
    requiredFreeBytes,
  }
}

/** 复制前计入所有目标副本，取消后不再扫描或准入新的大块写入。 */
export async function checkTaskCopyBudget(resource, copies, signal) {
  signal?.throwIfAborted()
  let additionalRootBytes = 0,
    additionalEvidenceBytes = 0
  for (const { source, destination, count = 1, filter } of copies) {
    signal?.throwIfAborted()
    assert(Number.isSafeInteger(count) && count > 0)
    let parent = resolve(destination)
    const suffix = []
    let target
    for (;;) {
      try {
        target = join(await realpath(parent), ...suffix)
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        assert.notEqual(dirname(parent), parent)
        suffix.unshift(basename(parent))
        parent = dirname(parent)
      }
    }
    assert(
      target.startsWith(resource.root + sep) || target.startsWith(resource.output + sep),
      'Copy must belong to the evaluation'
    )
    const bytes = (await directoryBytes(source, { filter, signal })) * count
    if (target.startsWith(resource.root + sep)) additionalRootBytes += bytes
    else additionalEvidenceBytes += bytes
  }
  return checkTaskResourceBudget(resource, { additionalRootBytes, additionalEvidenceBytes, signal })
}

/** 单次扫描不重叠；调用方取消任务后等待扫描收束再归档。 */
export function monitorTaskResources(resource, onFailure, intervalMs = 15_000) {
  let pending = null
  const timer = setInterval(() => {
    if (pending) return
    pending = checkTaskResourceBudget(resource)
      .catch(onFailure)
      .finally(() => {
        pending = null
      })
  }, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await pending
  }
}

async function* records(root, digest) {
  yield JSON.stringify({ type: 'format', version: 2 }) + '\n'
  let count = 0,
    totalBytes = 0
  for await (const entry of entries(root)) {
    count++
    digest.update(JSON.stringify(entry) + '\n')
    yield JSON.stringify(entry) + '\n'
    if (entry.type !== 'file') continue
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(join(root, entry.path), {
      highWaterMark: 64 * 1024,
    })) {
      hash.update(chunk)
      bytes += chunk.length
      yield JSON.stringify({ type: 'data', base64: chunk.toString('base64') }) + '\n'
    }
    assert.equal(bytes, entry.bytes, 'Resource changed while archiving')
    const sha256 = hash.digest('hex')
    totalBytes += bytes
    digest.update(sha256 + '\n')
    yield JSON.stringify({ type: 'end-file', sha256 }) + '\n'
  }
  yield JSON.stringify({
    type: 'end-archive',
    entries: count,
    bytes: totalBytes,
    contentSha256: digest.copy().digest('hex'),
  }) + '\n'
}

/** 流式重读每个文件并校验内容，归档中的链接只作为元数据。 */
export async function verifyResourceArchive(path) {
  const digest = createHash('sha256')
  const input = createReadStream(path)
  const unzip = createGunzip()
  const pumping = pipeline(input, unzip)
  void pumping.catch(() => {})
  const lines = createInterface({ input: unzip, crlfDelay: Infinity })
  let header = false,
    version,
    footer = false,
    file = null,
    hash = null,
    size = 0,
    bytes = 0,
    count = 0
  const names = new Set()
  try {
    for await (const line of lines) {
      assert(!footer, 'Trailing resource archive records')
      assert(line.length < 100_000, 'Archive record is oversized')
      const record = JSON.parse(line)
      if (!header) {
        assert([1, 2].includes(record.version), 'Unsupported resource archive version')
        assert.deepEqual(record, { type: 'format', version: record.version })
        version = record.version
        header = true
      } else if (record.type === 'end-archive') {
        assert(!file)
        assert.deepEqual(record, {
          type: 'end-archive',
          entries: count,
          bytes,
          contentSha256: digest.copy().digest('hex'),
        })
        footer = true
      } else if (record.type === 'data') {
        assert(file && typeof record.base64 === 'string')
        const chunk = Buffer.from(record.base64, 'base64')
        assert.equal(chunk.toString('base64'), record.base64)
        size += chunk.length
        assert(size <= file.bytes)
        hash.update(chunk)
      } else if (record.type === 'end-file') {
        assert(file)
        assert.equal(size, file.bytes)
        assert.equal(hash.digest('hex'), record.sha256)
        digest.update(record.sha256 + '\n')
        bytes += size
        file = null
      } else {
        assert(
          !file &&
            (version === 2
              ? ['file', 'directory', 'symlink', 'fifo']
              : ['file', 'directory', 'symlink']
            ).includes(record.type)
        )
        assert(
          typeof record.path === 'string' &&
            record.path &&
            !record.path.startsWith('/') &&
            !record.path.includes('\\')
        )
        assert(!record.path.split('/').some((part) => !part || part === '.' || part === '..'))
        assert(!names.has(record.path))
        assert(Number.isInteger(record.mode) && record.mode >= 0 && record.mode <= 0o777)
        if (record.type === 'symlink') assert(typeof record.target === 'string' && record.target)
        names.add(record.path)
        digest.update(JSON.stringify(record) + '\n')
        count++
        if (record.type === 'file') {
          assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0)
          file = record
          hash = createHash('sha256')
          size = 0
        }
      }
    }
    await pumping
    assert(header && footer && !file, 'Incomplete resource archive')
    return { entries: count, bytes, contentSha256: digest.digest('hex') }
  } finally {
    lines.close()
    unzip.destroy()
    input.destroy()
  }
}

async function syncPath(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 调用方先收束进程；持有独占锁直到验证完成与删除，不回收正在运行的其他尝试。 */
export async function archiveTaskResources(resource) {
  const release = await acquireTaskResources(resource)
  const archive = join(resource.output, 'execution-resources.jsonl.gz')
  const partial = archive + '.' + randomUUID() + '.partial'
  try {
    const digest = createHash('sha256')
    await pipeline(
      Readable.from(records(resource.root, digest)),
      createGzip(),
      createWriteStream(partial, { flags: 'wx', mode: 0o600 })
    )
    const expected = digest.digest('hex')
    const verified = await verifyResourceArchive(partial)
    assert.equal(verified.contentSha256, expected)
    // 校验之后再次读取根身份与全部文件，拒绝归档期间变化的产物。
    const current = createHash('sha256')
    for await (const _record of records(resource.root, current)) {
      /* 仅核对当前内容 */
    }
    assert.equal(current.digest('hex'), expected, 'Resources changed after archive')
    await owned(resource)
    await rename(partial, archive)
    await writeFile(
      join(resource.output, 'resources-archive.json'),
      JSON.stringify(
        {
          ...verified,
          archive: basename(archive),
          verifiedAt: new Date().toISOString(),
          root: resource.root,
        },
        null,
        2
      )
    )
    // 原始副本删除前，将归档、校验记录及目录项真正落盘。
    await syncPath(archive)
    await syncPath(join(resource.output, 'resources-archive.json'))
    await syncPath(resource.output)
    await rm(resource.root, { recursive: true })
    await writeFile(
      join(resource.output, 'resources-cleanup.json'),
      JSON.stringify({ releasedAt: new Date().toISOString(), bytes: verified.bytes }, null, 2)
    )
    return verified
  } finally {
    await rm(partial, { force: true })
    await release()
  }
}

/** 只还原到全新目录；目录与链接分别处理，任何后续写入都不得穿过链接。 */
export async function restoreResourceArchive(archive, destination) {
  const verified = await verifyResourceArchive(archive)
  await mkdir(destination, { mode: 0o700 })
  destination = await realpath(destination)
  const input = createReadStream(archive)
  const unzip = createGunzip()
  const pumping = pipeline(input, unzip)
  void pumping.catch(() => {})
  const lines = createInterface({ input: unzip, crlfDelay: Infinity })
  const directories = []
  let file
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line)
      if (entry.type === 'format' || entry.type === 'end-archive') continue
      if (entry.type === 'data') {
        await file.writeFile(Buffer.from(entry.base64, 'base64'))
        continue
      }
      if (entry.type === 'end-file') {
        await file.close()
        file = undefined
        continue
      }
      const target = resolve(destination, entry.path)
      assert(target.startsWith(destination + sep))
      assert.equal(await realpath(dirname(target)), dirname(target), 'Archive parent is a symlink')
      if (entry.type === 'directory') {
        await mkdir(target, { mode: 0o700 })
        directories.push([target, entry.mode])
      } else if (entry.type === 'symlink') await symlink(entry.target, target)
      else if (entry.type === 'fifo') {
        // 已结束测试留下的管道只恢复节点和权限，不打开或读取流。
        assert.notEqual(process.platform, 'win32', 'FIFO archive restoration requires a POSIX host')
        await promisify(execFile)('mkfifo', ['-m', entry.mode.toString(8), target], {
          env: { PATH: '/usr/bin:/bin' },
          timeout: 10000,
        })
      } else {
        file = await open(target, 'wx', 0o600)
        await file.chmod(entry.mode)
      }
    }
    await pumping
    for (const [path, mode] of directories.reverse()) await chmod(path, mode)
    const restored = createHash('sha256')
    for await (const _record of records(destination, restored)) {
      /* 还原内容和初次验证一致 */
    }
    assert.equal(
      restored.digest('hex'),
      verified.contentSha256,
      'Restored resources differ from verified archive'
    )
    return verified
  } finally {
    await file?.close()
    lines.close()
    unzip.destroy()
    input.destroy()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(
    ['--verify', '--restore', '--archive'].includes(process.argv[2]),
    'Usage: resource-lifecycle.mjs --verify archive | --restore archive new-directory | --archive resources.json'
  )
  console.log(
    JSON.stringify(
      process.argv[2] === '--archive'
        ? await archiveTaskResources(await json(resolve(process.argv[3])))
        : process.argv[2] === '--verify'
          ? await verifyResourceArchive(resolve(process.argv[3]))
          : await restoreResourceArchive(resolve(process.argv[3]), resolve(process.argv[4])),
      null,
      2
    )
  )
}
