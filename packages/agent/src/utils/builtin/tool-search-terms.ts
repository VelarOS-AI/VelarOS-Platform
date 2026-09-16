// 域：工具页检索的**查询词扩展与命中判定**（tooling:map(op:"find") 的召回层）。
//
// ## 算法与不变量
// 一次 find 的召回链是：`splitSearchTerms(query)` 把用户/模型的自然语句炸成候选词集合，
// `matchedTermsForField(value, terms)` 对每个字段做**小写子串命中**，命中条数 × 字段权重即得分
// （权重表在 Categories.ts）。因此本模块的产出是"宁可多给候选词"——多一个不命中的词只是白算一次
// `includes`，少一个词则整张页召不回来。
//
// 扩展分四路，都服务于同一个目标（让模型的自然说法命中开发者写的标识符）：
//  - **标识符拆分**：`readDocument` / `read_document` / `read.document` → read + document。
//    工具名与参数名是驼峰或蛇形，而模型问的是空格分词的短语。
//  - **英文词干**：刻意用**极简后缀剥离**而不是完整 Porter——这里只需要让 enabled/enabling/enables
//    落到同一个桶，用完整词干器会把 `parse`→`par` 之类的过度还原带进子串匹配，反而误召回。
//    长度下限（>3、ing 要 >5）就是防过度还原的闸。
//  - **中文 2/3-gram**：中文查询没有空格分词，靠滑窗切片让"读取文档"能命中"文档读取"。
//    只切 2 和 3 是因为再长的窗口对子串匹配没有增量（长片段必然包含短片段）。
//  - **同义词组**：双向展开的小词表，覆盖"开启/enable/激活"这类**同义但零共同子串**的说法——
//    这是前三路都救不了的一类失配，也是这张表存在的唯一理由（不是通用词典，别往里堆低频词）。
//
// 另有相邻词拼成的 2/3 词短语（`phraseSearchTerms`）：让"user action card"整体命中带空格的字段值，
// 单词拆开时它会被淹没在噪音里。

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

/**
 * 把一个标识符拆成小写词片：先在小写/数字与大写的交界处插空格拆驼峰，再按空白、`_`、`.`、`-` 切分，
 * 逐片 trim 后丢掉空片。`readDocument` / `read_document` / `read.document` 都拆成 `read` + `document`，
 * 好让模型用空格短语的说法命中开发者写的标识符。
 */
export function splitIdentifierSearchTerm(term: string): string[] {
  return term
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * 极简英文词干：只对纯小写字母且长度 > 3 的词动手，按 `ies→y`、`ing→`（去重复辅音，如 running→run）、
 * `ed→`、`es→`、`s→`（`ss` 结尾除外）依次剥后缀，其余原样返回。
 * 刻意不用完整 Porter——这里的下游是**子串匹配**，过度还原（`parse`→`par`）会把不相干的页也召回来；
 * 每条规则上的长度下限（ing 要 > 5，其余 > 4）就是防过度还原的闸。
 */
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

/**
 * 把一个查询词扩成候选词集合（去重后返回）：小写原词 + 英文词干 + 标识符拆分出的各片；
 * 含中文且长度 ≥ 3 时再加上 2-gram 与 3-gram 滑窗切片（中文没有空格分词，靠滑窗让「读取文档」
 * 命中「文档读取」；只切 2 和 3 是因为更长的窗口必然包含短片段，对子串匹配没有增量）；
 * 最后并入同义词表里原词与词干各自的同义词。宁可多给候选——多一个不命中的词只是白算一次
 * `includes`，少一个词则整张工具页召不回来。
 */
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

/**
 * 把相邻词按原顺序拼成 2 词与 3 词短语（空格连接），词数不够某个窗口就不产出该窗口的短语。
 * 用途是让「user action card」整体命中带空格的字段值——拆成单词后这几个常见词会被噪音淹没。
 */
function phraseSearchTerms(terms: readonly string[]): string[] {
  const phrases: string[] = []
  for (const size of [2, 3]) {
    for (let index = 0; index <= terms.length - size; index += 1) {
      phrases.push(terms.slice(index, index + size).join(' '))
    }
  }
  return phrases
}

/**
 * 召回层入口：把一句自然语言查询炸成候选词集合。先拆驼峰、转小写，按空白与
 * `, ， 。 / \ : ： ; ； | _` 切成原始词；再把原始词与它们拼出的 2/3 词短语各自过一遍
 * `expandSearchTerm`（词干、标识符拆分、中文 n-gram、同义词），最后整体去重。
 * 查询为空或全是分隔符时返回空数组——调用方据此不做打分。
 */
export function splitSearchTerms(query: string): string[] {
  const rawTerms = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s,，。/\\:：;；|_]+/)
    .map((term) => term.trim())
    .filter(Boolean)

  return [...new Set([...rawTerms, ...phraseSearchTerms(rawTerms)].flatMap(expandSearchTerm))]
}

/**
 * 在一个字段值里挑出命中的候选词：字段值转小写后做**子串包含**判定（不是分词匹配，
 * 所以词干与 n-gram 才有意义），返回全部命中的词。命中**条数**乘以字段权重即该字段得分，
 * 因此同一个词命中多次只算一次。一个都没中就返回空数组。
 */
export function matchedTermsForField(value: string, terms: readonly string[]): string[] {
  const normalized = value.toLowerCase()
  return terms.filter((term) => normalized.includes(term))
}
