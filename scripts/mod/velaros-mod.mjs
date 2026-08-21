#!/usr/bin/env bun
// VelarOS Mod v1 开发工具：确定性打包、校验与检查 `.velarmod`。
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

import JSZip from 'jszip'

import {
  parseAgentModManifest,
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '../../packages/agent/src/protocol/mods.ts'

const ArchiveExtension = '.velarmod'
const DeterministicDate = new Date('1980-01-01T00:00:00.000Z')
const MaxArchiveBytes = 32 * 1024 * 1024
const MaxFiles = 512
const MaxExpandedBytes = 128 * 1024 * 1024
const MaxCompressionRatio = 100
const ExcludedSourceDirectories = new Set(['.git', 'node_modules'])

function fail(message) {
  throw new Error(message)
}

function assertSafePath(path) {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    parts.includes('..') ||
    parts.length > 8 ||
    normalized.length > 240 ||
    hasControlCharacter
  )
    fail(`不安全的包内路径：${path}`)
  return normalized.normalize('NFC')
}

function addUniquePath(paths, path) {
  const folded = path.toLocaleLowerCase('en-US')
  if (paths.has(folded)) fail(`Mod 包含大小写或规范化后重复的路径：${path}`)
  paths.add(folded)
}

function parseManifest(bytes, origin, { bundled = false } = {}) {
  let raw
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(`${origin}/${VelarosModManifestFileName} 不是合法 JSON`)
  }
  const envelope = parseVelarosModEnvelope(raw, { origin })
  if (!envelope.ok) {
    fail(envelope.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; '))
  }
  if (envelope.envelope.agent !== undefined) {
    const agent = parseAgentModManifest(envelope.envelope.agent, { origin })
    if (!agent.ok) fail(agent.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; '))
    if (!bundled && agent.manifest.trust === 'bundled-official') {
      fail('外部分发包不能自报 bundled-official；只有官方宿主构建可使用 --bundled')
    }
  }
  return { raw, envelope: envelope.envelope }
}

async function readDirectoryEntries(root) {
  const entries = []
  let expandedBytes = 0
  const paths = new Set()
  const walk = async (directory) => {
    for (const dirent of await readdir(directory, { withFileTypes: true })) {
      if (dirent.isDirectory() && ExcludedSourceDirectories.has(dirent.name)) continue
      const absolute = resolve(directory, dirent.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) fail(`Mod 源码目录不能包含符号链接：${absolute}`)
      if (dirent.isDirectory()) await walk(absolute)
      else if (dirent.isFile()) {
        const path = assertSafePath(relative(root, absolute).split(sep).join('/'))
        addUniquePath(paths, path)
        const bytes = await readFile(absolute)
        expandedBytes += bytes.byteLength
        if (expandedBytes > MaxExpandedBytes) fail('Mod 解压体积超过 128 MiB')
        entries.push({ path, bytes })
        if (entries.length > MaxFiles) fail(`Mod 文件数超过 ${MaxFiles}`)
      }
    }
  }
  await walk(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function readArchiveEntries(archivePath) {
  const archiveBytes = await readFile(archivePath)
  if (archiveBytes.byteLength > MaxArchiveBytes) fail('Mod 压缩包超过 32 MiB')
  const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true })
  const entries = []
  let expandedBytes = 0
  const paths = new Set()
  for (const file of Object.values(zip.files)) {
    if (typeof file.unixPermissions === 'number' && (file.unixPermissions & 0o170000) === 0o120000)
      fail(`Mod 包不能包含符号链接：${file.unsafeOriginalName ?? file.name}`)
    if (file.dir) continue
    const path = assertSafePath(file.unsafeOriginalName ?? file.name)
    addUniquePath(paths, path)
    const compressedSize = Number(file._data?.compressedSize ?? 0)
    const declaredSize = Number(file._data?.uncompressedSize ?? 0)
    if (expandedBytes + declaredSize > MaxExpandedBytes) fail('Mod 解压体积超过 128 MiB')
    if (
      declaredSize > 1024 * 1024 &&
      compressedSize > 0 &&
      declaredSize / compressedSize > MaxCompressionRatio
    )
      fail(`Mod 包文件压缩比异常：${path}`)
    const bytes = await file.async('nodebuffer')
    if (bytes.byteLength !== declaredSize) fail(`Mod 包文件长度与目录记录不一致：${path}`)
    expandedBytes += bytes.byteLength
    if (expandedBytes > MaxExpandedBytes) fail('Mod 解压体积超过 128 MiB')
    entries.push({ path, bytes })
    if (entries.length > MaxFiles) fail(`Mod 文件数超过 ${MaxFiles}`)
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function validateEntries(entries, origin, options) {
  const manifest = entries.find((entry) => entry.path === VelarosModManifestFileName)
  if (!manifest) fail(`包根目录缺少 ${VelarosModManifestFileName}`)
  return parseManifest(manifest.bytes, origin, options)
}

async function pack(sourceArg, outputArg, options) {
  if (!sourceArg) fail('用法：bun run mod pack <source-directory> [output.velarmod] [--bundled]')
  const source = resolve(sourceArg)
  const entries = await readDirectoryEntries(source)
  const parsed = validateEntries(entries, source, options)
  const output = resolve(
    outputArg ?? `${parsed.envelope.module.id}-${parsed.envelope.module.version}${ArchiveExtension}`
  )
  if (extname(output).toLowerCase() !== ArchiveExtension)
    fail(`输出文件必须以 ${ArchiveExtension} 结尾`)

  const zip = new JSZip()
  for (const entry of entries)
    zip.file(entry.path, entry.bytes, {
      date: DeterministicDate,
      createFolders: false,
    })
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  })
  if (bytes.byteLength > MaxArchiveBytes) fail('Mod 压缩包超过 32 MiB')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, bytes)
  console.log(`${parsed.envelope.module.id}@${parsed.envelope.module.version} -> ${output}`)
}

async function inspect(inputArg, options) {
  if (!inputArg) fail('用法：bun run mod inspect <package.velarmod>')
  const input = resolve(inputArg)
  const entries = await readArchiveEntries(input)
  const parsed = validateEntries(entries, input, options)
  const agent = parsed.envelope.agent ?? {}
  console.log(
    JSON.stringify(
      {
        file: basename(input),
        id: parsed.envelope.module.id,
        version: parsed.envelope.module.version,
        publisher: agent.publisher ?? '',
        trustClaim: agent.trust ?? '',
        permissions: parsed.envelope.module.permissions,
        fileCount: entries.length,
        expandedBytes: entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      },
      null,
      2
    )
  )
}

async function validate(inputArg, options) {
  if (!inputArg) fail('用法：bun run mod validate <source-directory|package.velarmod>')
  const input = resolve(inputArg)
  const info = await lstat(input)
  const entries = info.isDirectory()
    ? await readDirectoryEntries(input)
    : await readArchiveEntries(input)
  const parsed = validateEntries(entries, input, options)
  console.log(`valid ${parsed.envelope.module.id}@${parsed.envelope.module.version}`)
}

const [command, ...rawArgs] = process.argv.slice(2)
const bundled = rawArgs.includes('--bundled')
const args = rawArgs.filter((arg) => arg !== '--bundled')

if (command === 'pack') await pack(args[0], args[1], { bundled })
else if (command === 'inspect') await inspect(args[0], { bundled })
else if (command === 'validate') await validate(args[0], { bundled })
else fail('用法：bun run mod <pack|validate|inspect> ...')
