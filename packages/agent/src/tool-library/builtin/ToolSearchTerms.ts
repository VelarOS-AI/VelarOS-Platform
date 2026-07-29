const ToolSearchSynonymGroups: readonly string[][] = [
  [
    'enable',
    'enabled',
    'enabling',
    'activate',
    'activation',
    'turn on',
    'open',
    'load',
    '开启',
    '启用',
    '激活',
    '打开',
  ],
  ['disable', 'disabled', 'deactivate', 'turn off', 'unload', '关闭', '停用', '禁用'],
  ['plugin', 'extension', 'connector', 'capability', 'feature', '插件', '连接器', '能力'],
  ['action', 'operation', 'user action', '用户动作', '用户操作', '动作', '操作'],
  [
    'approval',
    'approve',
    'confirmation',
    'confirm',
    'authorization',
    'permission',
    '用户确认',
    '授权',
    '批准',
  ],
  [
    'prompt',
    'card',
    'cards',
    'dialog',
    'action card',
    'action cards',
    '动作卡',
    '动作卡片',
    '卡片',
  ],
  ['show', 'display', 'render', 'present', '展示', '显示'],
  ['command', 'commands', 'cmd', 'shell', 'terminal', 'process', 'exec', '命令', '终端'],
  ['search', 'find', 'lookup', 'query', '搜索', '查找', '查询'],
  ['read', 'inspect', 'view', 'list', '读取', '查看', '列出'],
  ['write', 'edit', 'modify', 'update', 'save', '写入', '编辑', '修改', '保存'],
  [
    'timeout',
    'timeoutms',
    'deadline',
    'duration',
    'millisecond',
    'milliseconds',
    'ms',
    '超时',
    '毫秒',
  ],
  ['url', 'uri', 'link', 'address', '网址', '链接', '地址'],
  ['path', 'file', 'filename', 'directory', 'cwd', 'working directory', '路径', '文件', '目录'],
]

const ToolSearchSynonyms = new Map<string, string[]>(
  ToolSearchSynonymGroups.flatMap((group) =>
    group.map((term) => [term, group.filter((candidate) => candidate !== term)] as const)
  )
)

export function splitIdentifierSearchTerm(term: string): string[] {
  return term
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function stemEnglishSearchTerm(term: string): string {
  if (!/^[a-z]+$/.test(term) || term.length <= 3) return term
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`
  if (term.endsWith('ing') && term.length > 5) {
    const stem = term.slice(0, -3)
    return /([a-z])\1$/.test(stem) ? stem.slice(0, -1) : stem
  }
  if (term.endsWith('ed') && term.length > 4) return term.slice(0, -2)
  if (term.endsWith('es') && term.length > 4) return term.slice(0, -2)
  if (term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

function expandSearchTerm(term: string): string[] {
  const normalized = term.toLowerCase()
  const stemmed = stemEnglishSearchTerm(normalized)
  const terms = [normalized, stemmed, ...splitIdentifierSearchTerm(term)]
  if (/[一-龥]/.test(term) && [...term].length >= 3) {
    const chars = [...term]
    for (const size of [2, 3]) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        terms.push(chars.slice(index, index + size).join(''))
      }
    }
  }

  return [
    ...new Set([
      ...terms,
      ...(ToolSearchSynonyms.get(normalized) ?? []),
      ...(ToolSearchSynonyms.get(stemmed) ?? []),
    ]),
  ]
}

function phraseSearchTerms(terms: readonly string[]): string[] {
  const phrases: string[] = []
  for (const size of [2, 3]) {
    for (let index = 0; index <= terms.length - size; index += 1) {
      phrases.push(terms.slice(index, index + size).join(' '))
    }
  }
  return phrases
}

export function splitSearchTerms(query: string): string[] {
  const rawTerms = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s,，。/\\:：;；|_]+/)
    .map((term) => term.trim())
    .filter(Boolean)

  return [...new Set([...rawTerms, ...phraseSearchTerms(rawTerms)].flatMap(expandSearchTerm))]
}

export function matchedTermsForField(value: string, terms: readonly string[]): string[] {
  const normalized = value.toLowerCase()
  return terms.filter((term) => normalized.includes(term))
}
