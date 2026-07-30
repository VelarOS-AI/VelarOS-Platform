/**
 * `memory-files` 构造级探针（bun 直驱，IO 全注入，不落一个真实文件）。
 *
 * 覆盖批一的四条验收面：
 *  ① 写入 → 索引 → 召回往返（含「按需全文」：召回结果带正文，未命中的条目不被读取）；
 *  ② frontmatter 宽容解析（缺失 / CRLF / BOM / 别名 key / 引号 / 未知字段保真）；
 *  ③ 作用域双轨（全局 userData 面 + 项目 `.velaros/memory/` 面，路径全部由宿主注入）；
 *  ④ 归档语义（撤索引行、文件保留、深层召回仍可捞回）。
 *
 * token 解析后端切换在 `../adapter-kernel/memory-store-capability-probe.ts`——那条链路要够着
 * kernel 注册表，按方向铁律只能住适配器切片。
 */

import assert from 'node:assert/strict'

import type { MemoryEvidenceInput } from '../memory-tree/Types'

import { createMemoryFilesBackend, type MemoryFilesScopeRoot } from './Backend'
import { parseMemoryFileDocument, serializeMemoryFileDocument } from './Frontmatter'
import { parseMemoryIndex } from './IndexFile'
import { createInMemoryMemoryFilesIo, type InMemoryMemoryFilesIo } from './Io'

const ExpectedAssertionCount = 70
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

const GlobalRoot: MemoryFilesScopeRoot = {
  scopeType: 'global',
  scopeId: 'global',
  directory: '/userData/memory',
}
const ProjectRoot: MemoryFilesScopeRoot = {
  scopeType: 'workspace',
  scopeId: 'project:/repos/velaros',
  directory: '/repos/velaros/.velaros/memory',
}

function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'agent_tool',
    trustLevel: 'agent_derived',
    content: '默认证据正文。',
    ...overrides,
  }
}

function createBackend(io: InMemoryMemoryFilesIo, roots = [GlobalRoot, ProjectRoot]) {
  return createMemoryFilesBackend({ roots, io, now: () => 1_700_000_000_000 })
}

// ── ① 写入 → 索引 → 召回往返 ────────────────────────────────────────────────
async function probeRoundTrip(): Promise<void> {
  const io = createInMemoryMemoryFilesIo()
  const backend = createBackend(io)

  const captured = backend.capture(
    evidence({
      title: '回复风格',
      content: '用户偏好简洁中文回答，先给结论再展开细节。',
      category: 'preference',
      scopeId: 'global',
      metadata: { summary: '先结论后细节的简洁中文', tags: ['style', 'zh'] },
    }),
  ) as { evidence: { id: string }; inserted: boolean }

  check(captured.inserted, '首次写入应为 inserted')
  const files = io.snapshot()
  const entryPath = '/userData/memory/entries/回复风格.md'
  check(entryPath in files, `条目文件应落在全局根：${Object.keys(files).join(', ')}`)
  check('/userData/memory/MEMORY.md' in files, '索引文件应被创建')

  const document = parseMemoryFileDocument(files[entryPath])
  equal(document.name, '回复风格', 'frontmatter name 应为标题')
  equal(document.description, '先结论后细节的简洁中文', 'description 取 metadata.summary')
  equal(document.type, 'preference', 'type 应为证据类别')
  equal(document.attributes.scope, 'global', 'scope 写入 frontmatter')
  equal(document.attributes.tags, 'style, zh', 'tags 按逗号拼接保留')
  equal(document.body, '用户偏好简洁中文回答，先给结论再展开细节。', '正文原样保留')

  const index = parseMemoryIndex(files['/userData/memory/MEMORY.md'])
  equal(index.length, 1, '索引应有一行')
  equal(index[0].path, 'entries/回复风格.md', '索引行指向条目文件')
  equal(index[0].name, '回复风格', '索引行携带名字')
  equal(index[0].description, '先结论后细节的简洁中文', '索引行携带描述')

  const recalled = backend.recall('回复风格', { limit: 5 }) as Array<{
    id: string
    title: string
    summary: string
    value: unknown
    scopeId: string
    path: unknown[]
  }>
  equal(recalled.length, 1, '召回应命中一条')
  equal(recalled[0].title, '回复风格', '召回标题回填自文件')
  equal(recalled[0].summary, '先结论后细节的简洁中文', '召回摘要来自索引/frontmatter')
  equal(
    recalled[0].value,
    '用户偏好简洁中文回答，先给结论再展开细节。',
    '按需全文：命中后回文件取正文',
  )
  equal(recalled[0].scopeId, 'global', '召回带回作用域')
  equal(recalled[0].path.length, 0, '文件后端没有树路径，空数组是诚实回答')

  const byId = backend.getItem(recalled[0].id) as Nullable<{ title: string }>
  equal(byId?.title, '回复风格', 'getItem 按 id 回读同一条')
  equal(backend.getItem('不存在::entries/x.md'), null, '未知作用域返回 null 而不抛')

  // 幂等：同一稳定键 + 同一内容重复写入不产生第二个文件，也不算 inserted。
  const again = backend.capture(
    evidence({
      title: '回复风格',
      content: '用户偏好简洁中文回答，先给结论再展开细节。',
      category: 'preference',
      scopeId: 'global',
      metadata: { summary: '先结论后细节的简洁中文', tags: ['style', 'zh'] },
    }),
  ) as { inserted: boolean }
  check(!again.inserted, '同内容重复写入应为非 inserted')
  equal(
    parseMemoryIndex(io.snapshot()['/userData/memory/MEMORY.md']).length,
    1,
    '幂等写入不应新增索引行',
  )

  // 未命中的条目不该被读进召回结果——索引行匹配是第一道闸。
  await backend.capture(
    evidence({ title: '完全无关的主题', content: '数据库连接池调参笔记。', scopeId: 'global' }),
  )
  const narrowed = backend.recall('回复风格', { limit: 5 }) as Array<{ title: string }>
  equal(narrowed.length, 1, '索引不匹配的条目不进召回')
  equal(narrowed[0].title, '回复风格', '仍是原条目')

  // 空查询 = browse：返回全部（最近写入优先）。
  const browsed = backend.recall('', { limit: 10 }) as Array<{ title: string }>
  equal(browsed.length, 2, '空查询返回全部条目')
  equal(browsed[0].title, '完全无关的主题', '空查询按最近写入优先')

  // 类别过滤在读到的文档上完成。
  const filtered = backend.recall('', { limit: 10, categories: ['preference'] }) as Array<{
    title: string
  }>
  equal(filtered.length, 1, '类别过滤生效')
  equal(filtered[0].title, '回复风格', '只剩 preference 条目')
}

// ── ② frontmatter 宽容解析 ─────────────────────────────────────────────────
async function probeForgivingFrontmatter(): Promise<void> {
  const missing = parseMemoryFileDocument('# 手写标题\n\n这是第一段描述。\n\n第二段。', 'fallback')
  check(!missing.hadFrontmatter, '无 frontmatter 时 hadFrontmatter=false')
  equal(missing.name, '手写标题', '缺 name 时取正文首个标题')
  equal(missing.description, '这是第一段描述。', '缺 description 时取首段')
  equal(missing.type, 'fact', 'type 缺省为 fact')

  const empty = parseMemoryFileDocument('', 'slug-fallback')
  equal(empty.name, 'slug-fallback', '空文件回落到文件名 slug')
  equal(empty.body, '', '空文件正文为空')

  const aliased = parseMemoryFileDocument(
    '﻿---\r\ntitle: "别名标题"\r\nsummary: \'别名摘要\'\r\nkind: task\r\ncustom: 保留我\r\n---\r\n\r\n正文。\r\n',
    'x',
  )
  check(aliased.hadFrontmatter, 'BOM + CRLF 仍应识别出 frontmatter')
  equal(aliased.name, '别名标题', 'title 别名映射到 name')
  equal(aliased.description, '别名摘要', 'summary 别名映射到 description')
  equal(aliased.type, 'task', 'kind 别名映射到 type')
  equal(aliased.attributes.custom, '保留我', '未知字段原样保留')
  equal(aliased.body, '正文。', 'CRLF 正文归一化')

  const spaced = parseMemoryFileDocument('----\nname   :   带空格\n----\n\n体。', 'x')
  equal(spaced.name, '带空格', '多于三个短横的 fence 与松散冒号都认')

  const unterminated = parseMemoryFileDocument('---\nname: 未闭合\n\n正文其实在这里。', 'x')
  check(!unterminated.hadFrontmatter, '未闭合 fence 不算 frontmatter')
  check(
    unterminated.body.includes('name: 未闭合'),
    '未闭合时整篇当正文，绝不吞掉用户内容',
  )

  const roundTripped = parseMemoryFileDocument(
    serializeMemoryFileDocument({
      name: '# 以井号开头',
      description: '',
      type: 'fact',
      attributes: { custom: 'v', created: '1' },
      body: '正文',
    }),
    'x',
  )
  equal(roundTripped.name, '# 以井号开头', '特殊起始字符经引号往返保真')
  equal(roundTripped.description, '正文', '空描述回落到首段推断')
  equal(roundTripped.attributes.custom, 'v', '未知字段写回后仍在')
}

// ── ③ 作用域双轨 ───────────────────────────────────────────────────────────
async function probeDualScope(): Promise<void> {
  const io = createInMemoryMemoryFilesIo()
  const backend = createBackend(io)

  await backend.capture(evidence({ title: '全局偏好', content: '全局内容。', scopeId: 'global' }))
  await backend.capture(
    evidence({
      title: '项目约定',
      content: '本仓提交前必跑 check。',
      scopeType: 'workspace',
      scopeId: 'project:/repos/velaros',
      workspaceRoot: '/repos/velaros',
    }),
  )

  const files = io.snapshot()
  check(
    '/repos/velaros/.velaros/memory/entries/项目约定.md' in files,
    '项目记忆落在仓根 .velaros/memory（随 git）',
  )
  check(
    '/userData/memory/entries/全局偏好.md' in files,
    '全局记忆落在宿主注入的 userData 面',
  )
  check(
    !('/userData/memory/entries/项目约定.md' in files),
    '项目记忆不得渗进全局面',
  )

  // 作用域收敛召回：项目作用域 + 允许 global。
  const scoped = backend.recall('', {
    limit: 10,
    scopeId: 'project:/repos/velaros',
  }) as Array<{ scopeId: string }>
  equal(scoped.length, 2, 'includeGlobal 缺省为真：项目 + 全局都在')

  const strict = backend.recall('', {
    limit: 10,
    scopeId: 'project:/repos/velaros',
    includeGlobal: false,
  }) as Array<{ scopeId: string }>
  equal(strict.length, 1, 'includeGlobal=false 严格隔离')
  equal(strict[0].scopeId, 'project:/repos/velaros', '只剩项目作用域')

  // 只读根不接受写入（别人 clone 来的共享记忆）。
  const readOnlyIo = createInMemoryMemoryFilesIo()
  const readOnlyBackend = createMemoryFilesBackend({
    roots: [GlobalRoot, { ...ProjectRoot, readOnly: true }],
    io: readOnlyIo,
  })
  await readOnlyBackend.capture(
    evidence({
      title: '想写进只读根',
      content: '内容。',
      scopeId: 'project:/repos/velaros',
      scopeType: 'workspace',
    }),
  )
  check(
    !Object.keys(readOnlyIo.snapshot()).some((path) => path.startsWith('/repos/')),
    '只读根不接受写入，回落到可写根',
  )

  // 根解析是每次调用重新求值：宿主换项目不必重建后端。
  let activeRoots: MemoryFilesScopeRoot[] = [GlobalRoot]
  const dynamicIo = createInMemoryMemoryFilesIo()
  const dynamic = createMemoryFilesBackend({ roots: () => activeRoots, io: dynamicIo })
  await dynamic.capture(evidence({ title: '第一处', content: 'a' }))
  activeRoots = [ProjectRoot]
  await dynamic.capture(evidence({ title: '第二处', content: 'b' }))
  const dynamicFiles = dynamicIo.snapshot()
  check('/userData/memory/entries/第一处.md' in dynamicFiles, '切换前写全局根')
  check(
    '/repos/velaros/.velaros/memory/entries/第二处.md' in dynamicFiles,
    '切换后写项目根（根解析每次重新求值）',
  )
}

// ── ④ 归档语义 ─────────────────────────────────────────────────────────────
async function probeArchive(): Promise<void> {
  const io = createInMemoryMemoryFilesIo()
  const backend = createBackend(io, [GlobalRoot])
  const captured = backend.capture(
    evidence({ title: '过时结论', content: '旧项目才适用的偏好。', scopeId: 'global' }),
  ) as { evidence: { id: string } }

  const erased = backend.erase?.(captured.evidence.id) as { claimId: string }
  equal(erased.claimId, captured.evidence.id, 'erase 回报同一 id')

  const files = io.snapshot()
  check(
    '/userData/memory/entries/过时结论.md' in files,
    '归档不删文件——权威内容永不静默硬删',
  )
  equal(
    parseMemoryFileDocument(files['/userData/memory/entries/过时结论.md']).attributes.status,
    'archived',
    '归档在 frontmatter 打 status: archived',
  )
  equal(parseMemoryIndex(files['/userData/memory/MEMORY.md']).length, 0, '归档撤索引行')

  equal((backend.recall('过时结论', { limit: 5 }) as unknown[]).length, 0, '普通召回不返回归档条目')
  equal(
    (backend.recall('过时结论', { limit: 5, includeDormant: true }) as unknown[]).length,
    1,
    'includeDormant 深层召回仍可捞回（索引缺席时按目录重建）',
  )
}

// ── 后端自述 ───────────────────────────────────────────────────────────────
async function probeDescriptor(): Promise<void> {
  const backend = createBackend(createInMemoryMemoryFilesIo())
  equal(backend.descriptor.id, 'files', '后端 id 为 files')
  equal(backend.descriptor.role, 'authority', 'files 是权威层')
  check(backend.descriptor.verbs.includes('capture'), 'capture 在动词表内')
  check(backend.descriptor.verbs.includes('recall'), 'recall 在动词表内')
  check(!backend.descriptor.verbs.includes('dream'), 'dream 缺席 = 没装就没有，不是降级')
  equal(backend.dream, undefined, 'dream 动词在实现上也必须缺席')

  const stats = backend.inspect() as { backendId: string; pendingCount: number }
  equal(stats.backendId, 'files', 'inspect 自报后端 id')
  equal(stats.pendingCount, 0, '文件后端写入即最终态，无待整理队列')
}

await probeRoundTrip()
await probeForgivingFrontmatter()
await probeDualScope()
await probeArchive()
await probeDescriptor()

assert.equal(
  assertionCount,
  ExpectedAssertionCount,
  `断言数应为 ${ExpectedAssertionCount}，实际 ${assertionCount}（改动断言时同步更新常量）`,
)
console.info(`[memory-files] 探针通过：${assertionCount} 条断言。`)
