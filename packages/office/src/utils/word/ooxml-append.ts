/**
 * Word 追加写的 OOXML 原语：取出片段正文、缝进目标文档、重发关系与编号 id、补齐样式与部件登记。
 *
 * ── 追加写的五条不变量（§5.3b ①算法与协议）──────────────────────────────
 *
 * 追加模式不重排版整篇文档，而是**把新片段的 XML 直接缝进已有 .docx 的 zip 里**。这么做的原因是
 * 读回再重排会丢掉原文档里 docx 库不认识的一切（样式、编号、页眉页脚、批注）。代价是必须自己
 * 守住 OOXML 的四条结构约束——下面每个 helper 各守一条，改任意一处前先确认还成立：
 *
 * 1. **`w:sectPr` 必须留在 body 末尾**。它是整节的排版设置（纸张、页边距、页眉引用）；
 *    被复制到中间或被新内容挤到后面，Word 会判定文档损坏或分节错乱。故取片段时剔除它
 *    （`extractWordBodyChildrenXml`），插入时插到它**之前**（`insertWordBodyChildrenXml`）。
 * 2. **relationship id 是每文档局部的**。片段里的 `rId3` 与原文档的 `rId3` 毫不相干，
 *    直接合并会让超链接指向错误目标、图片错位。故 `mergeWordDocumentRelationships` 逐条重发号
 *    （`rIdAppendN`，同时避开已有的 `rIdN`）并同步改写片段正文里的 `r:id/r:embed/r:link`。
 * 3. **只合并被真正引用的 relationship**（`wordChildrenReferenceRelationship`）。docx 库会给片段
 *    带一堆默认关系，全并进去会在原文档里留下悬空条目。
 * 4. **结构不完整一律拒绝，不"尽力而为"**：找不到 `w:body`、`w:sectPr` 不闭合、`</Relationships>`
 *    缺失，全部抛 VALIDATION。这里的失败方向必须是"不写"——半写成功的 .docx 打不开，
 *    而用户的原文档已经被覆盖（§2.4 最坏失败模式决定设计）。
 * 5. **正文引用的定义要跟着正文一起搬**（`mergeWordNumberingDefinitions` /
 *    `mergeWordStyleDefinitions`）。`w:numId` 与 rId 一样是每文档局部的，样式则按 id 找定义：
 *    只缝正文不搬定义，追加的项目符号与标题在目标文档里要么退化成普通段落，要么串到别人的
 *    列表上。编号连带重发号（正文引用一次改写），样式只补目标缺的那些（同名一律用目标的，
 *    追加内容跟着宿主文档的观感走）。
 */

import { readFile } from 'node:fs/promises'

import JSZip from 'jszip'

import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { OfficeOutput } from '../../types/office.js'
import type { WordSupportPart } from '../../types/word.js'
import { writeOfficeBuffer } from '../paths.js'

/** document.xml 在 docx 包里的路径。 */
const WordDocumentXmlPath = 'word/document.xml'
/** document.xml 的关系文件路径。 */
const WordDocumentRelsPath = 'word/_rels/document.xml.rels'
/** 编号定义部件的路径。 */
const WordNumberingXmlPath = 'word/numbering.xml'
/** 样式定义部件的路径。 */
const WordStylesXmlPath = 'word/styles.xml'
/** 包级内容类型清单的路径。 */
const WordContentTypesXmlPath = '[Content_Types].xml'
/** 部件的内容类型与关系类型；目标文档第一次拿到编号/样式部件时要把这两处一起登记上。 */
const WordSupportParts: Readonly<Record<'numbering' | 'styles', WordSupportPart>> = {
  numbering: {
    path: WordNumberingXmlPath,
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    relationshipType:
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  },
  styles: {
    path: WordStylesXmlPath,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    relationshipType:
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  },
}
/** 匹配一整个 Relationship 元素（自闭合或带结束标签）。 */
const WordRelationshipElementRegex =
  /<Relationship\b[^>]*\bId="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/Relationship>)/g
/** 匹配 Relationship 元素上的 Id 属性。 */
const WordRelationshipIdRegex = /\bId="([^"]+)"/g

/** 读取 zip 里的文本部件；没有这个部件时返回 null。 */
async function readWordZipText(zip: JSZip, path: string): Promise<Nullable<string>> {
  const file = zip.file(path)
  return file ? file.async('string') : null
}

/** 将 fragment docx 的 body 内容追加到已有 docx，并把它引用到的关系、编号与样式一起并过去。 */
export async function appendWordDocumentBuffer(
  prepared: { path: string; created: boolean },
  fragmentBuffer: Buffer
): Promise<OfficeOutput> {
  const existingZip = await JSZip.loadAsync(await readFile(prepared.path))
  const fragmentZip = await JSZip.loadAsync(fragmentBuffer)
  const existingDocumentFile = existingZip.file(WordDocumentXmlPath)
  const fragmentDocumentFile = fragmentZip.file(WordDocumentXmlPath)
  if (!existingDocumentFile || !fragmentDocumentFile)
    throw new AppError('VALIDATION', '目标 Word 文档缺少 word/document.xml，无法追加内容。')

  const existingDocumentXml = await existingDocumentFile.async('string')
  const fragmentDocumentXml = await fragmentDocumentFile.async('string')
  let fragmentChildrenXml = extractWordBodyChildrenXml(fragmentDocumentXml).trim()
  if (!fragmentChildrenXml) throw new AppError('VALIDATION', '追加内容为空，未写入 Word 文档。')

  // 追加超链接/媒体时要合并 relationship，并重写 fragment 中的 rId。
  const existingRelsFile = existingZip.file(WordDocumentRelsPath)
  const fragmentRelsFile = fragmentZip.file(WordDocumentRelsPath)
  const existingRelsXml = existingRelsFile
    ? await existingRelsFile.async('string')
    : createEmptyWordDocumentRelsXml()
  const fragmentRelsXml = fragmentRelsFile ? await fragmentRelsFile.async('string') : null
  const mergedRels = mergeWordDocumentRelationships(
    existingRelsXml,
    fragmentRelsXml,
    fragmentChildrenXml
  )
  fragmentChildrenXml = mergedRels.fragmentChildrenXml

  // 编号与样式定义跟着正文一起并过去，否则追加的列表与标题会引用目标文档里不存在（或属于
  // 别人）的定义，见下面 mergeWordNumberingDefinitions 的判据。
  const numbering = mergeWordNumberingDefinitions({
    existingNumberingXml: await readWordZipText(existingZip, WordNumberingXmlPath),
    fragmentNumberingXml: await readWordZipText(fragmentZip, WordNumberingXmlPath),
    fragmentChildrenXml,
  })
  fragmentChildrenXml = numbering.fragmentChildrenXml
  const stylesXml = mergeWordStyleDefinitions({
    existingStylesXml: await readWordZipText(existingZip, WordStylesXmlPath),
    fragmentStylesXml: await readWordZipText(fragmentZip, WordStylesXmlPath),
    fragmentChildrenXml,
  })

  let contentTypesXml = await readWordZipText(existingZip, WordContentTypesXmlPath)
  let relationshipsXml = mergedRels.relationshipsXml
  for (const [part, mergedXml] of [
    [WordSupportParts.numbering, numbering.numberingXml],
    [WordSupportParts.styles, stylesXml],
  ] as const) {
    if (!mergedXml) continue
    existingZip.file(part.path, mergedXml)
    contentTypesXml = registerWordPartContentType(contentTypesXml, part)
    relationshipsXml = registerWordPartRelationship(relationshipsXml, part)
  }
  if (contentTypesXml) existingZip.file(WordContentTypesXmlPath, contentTypesXml)

  existingZip.file(
    WordDocumentXmlPath,
    insertWordBodyChildrenXml(existingDocumentXml, fragmentChildrenXml)
  )
  existingZip.file(WordDocumentRelsPath, relationshipsXml)
  const mergedBuffer = await existingZip.generateAsync({ type: 'nodebuffer' })
  return writeOfficeBuffer(prepared, mergedBuffer, 'docx')
}

/** 提取 document.xml body 中除 sectPr 外的内容。 */
export function extractWordBodyChildrenXml(documentXml: string): string {
  const body = findWordBodyRange(documentXml)
  const bodyInner = documentXml.slice(body.openEnd, body.closeStart)
  const sectPr = findWordSectPrRange(bodyInner)
  if (!sectPr) return bodyInner
  return `${bodyInner.slice(0, sectPr.start)}${bodyInner.slice(sectPr.end)}`
}

/** 将新的 children XML 插入到 body 末尾、sectPr 之前。 */
export function insertWordBodyChildrenXml(documentXml: string, childrenXml: string): string {
  const body = findWordBodyRange(documentXml)
  const bodyInner = documentXml.slice(body.openEnd, body.closeStart)
  const sectPr = findWordSectPrRange(bodyInner)
  const insertOffset = body.openEnd + (sectPr?.start ?? bodyInner.length)
  return `${documentXml.slice(0, insertOffset)}${childrenXml}${documentXml.slice(insertOffset)}`
}

/** 定位 Word document.xml 中 w:body 的内层范围。 */
export function findWordBodyRange(documentXml: string): { openEnd: number; closeStart: number } {
  const bodyOpen = /<w:body(?:\s[^>]*)?>/.exec(documentXml)
  const bodyCloseStart = documentXml.lastIndexOf('</w:body>')
  if (!bodyOpen || bodyOpen.index < 0 || bodyCloseStart < 0)
    throw new AppError('VALIDATION', 'Word 文档 XML 缺少 w:body，无法追加内容。')
  return { openEnd: bodyOpen.index + bodyOpen[0].length, closeStart: bodyCloseStart }
}

/** 定位 w:sectPr 范围；追加内容时不能把它复制到中间。 */
export function findWordSectPrRange(bodyInnerXml: string): Nullable<{ start: number; end: number }> {
  const start = bodyInnerXml.lastIndexOf('<w:sectPr')
  if (start < 0) return null
  const openEnd = bodyInnerXml.indexOf('>', start)
  if (openEnd < 0) throw new AppError('VALIDATION', 'Word 文档 XML 中 w:sectPr 结构不完整。')
  if (bodyInnerXml[openEnd - 1] === '/') return { start, end: openEnd + 1 }
  const closeTag = '</w:sectPr>'
  const closeStart = bodyInnerXml.indexOf(closeTag, openEnd)
  if (closeStart < 0) throw new AppError('VALIDATION', 'Word 文档 XML 中 w:sectPr 缺少结束标签。')
  return { start, end: closeStart + closeTag.length }
}

/** 合并 fragment relationships，并重写 fragment children 中引用的 rId。 */
export function mergeWordDocumentRelationships(
  existingRelsXml: string,
  fragmentRelsXml: Nullable<string>,
  fragmentChildrenXml: string
): { relationshipsXml: string; fragmentChildrenXml: string } {
  if (!fragmentRelsXml) return { relationshipsXml: existingRelsXml, fragmentChildrenXml }
  const existingIds = collectWordRelationshipIds(existingRelsXml)
  const additions: string[] = []
  let remappedChildrenXml = fragmentChildrenXml
  for (const match of fragmentRelsXml.matchAll(WordRelationshipElementRegex)) {
    const oldId = match[1]
    const relationshipXml = match[0]
    // 只合并 fragment body 实际引用到的 relationship。
    if (!oldId || !wordChildrenReferenceRelationship(remappedChildrenXml, oldId)) continue
    const newId = createUniqueWordRelationshipId(existingIds)
    additions.push(replaceWordRelationshipElementId(relationshipXml, oldId, newId))
    remappedChildrenXml = replaceWordChildRelationshipReferences(remappedChildrenXml, oldId, newId)
  }
  if (isEmpty(additions))
    return { relationshipsXml: existingRelsXml, fragmentChildrenXml: remappedChildrenXml }
  const closeIndex = existingRelsXml.lastIndexOf('</Relationships>')
  if (closeIndex < 0)
    throw new AppError('VALIDATION', 'Word 文档关系文件结构不完整，无法追加链接或媒体关系。')
  return {
    relationshipsXml: `${existingRelsXml.slice(0, closeIndex)}${additions.join('')}${existingRelsXml.slice(closeIndex)}`,
    fragmentChildrenXml: remappedChildrenXml,
  }
}

/** 收集现有 relationship id，用于生成不冲突的新 id。 */
export function collectWordRelationshipIds(relsXml: string): Set<string> {
  const ids = new Set<string>()
  for (const match of relsXml.matchAll(WordRelationshipIdRegex)) {
    if (match[1]) ids.add(match[1])
  }
  return ids
}

/** 判断 body children 是否引用指定 relationship。 */
export function wordChildrenReferenceRelationship(childrenXml: string, relationshipId: string): boolean {
  return new RegExp(`\\br:(?:id|embed|link)=["']${escapeRegExp(relationshipId)}["']`).test(
    childrenXml
  )
}

/** 替换 Relationship 元素本身的 Id。 */
export function replaceWordRelationshipElementId(
  relationshipXml: string,
  oldId: string,
  newId: string
): string {
  return relationshipXml.replace(new RegExp(`\\bId="${escapeRegExp(oldId)}"`), `Id="${newId}"`)
}

/** 替换 body children 中的 r:id/r:embed/r:link 引用。 */
export function replaceWordChildRelationshipReferences(
  childrenXml: string,
  oldId: string,
  newId: string
): string {
  return childrenXml.replace(
    new RegExp(`(\\br:(?:id|embed|link)=["'])${escapeRegExp(oldId)}(["'])`, 'g'),
    `$1${newId}$2`
  )
}

/** 创建不会与已有 rId 冲突的新 relationship id。 */
export function createUniqueWordRelationshipId(existingIds: Set<string>): string {
  let index = 1
  while (existingIds.has(`rIdAppend${index}`) || existingIds.has(`rId${index}`)) index += 1
  const id = `rIdAppend${index}`
  existingIds.add(id)
  return id
}

// ─── OOXML 追加写：编号与样式定义 ───────────────────────────────────────────────

/** 取出 XML 里某种元素，按它的 id 属性索引；同 id 只留第一个。 */
function readWordXmlElements(
  xml: string,
  tagName: string,
  idAttribute: string
): Map<string, string> {
  const elements = new Map<string, string>()
  // 标签名后强制跟空白，`w:num` 才不会连 `w:numPr`、`w:numId`、`w:numFmt` 一起吃掉。
  const pattern = new RegExp(`<${tagName}\\s[^>]*?(?:/>|>[\\s\\S]*?</${tagName}>)`, 'g')
  for (const match of xml.matchAll(pattern)) {
    const id = new RegExp(`\\b${idAttribute}="([^"]+)"`).exec(match[0])?.[1]
    if (isString(id) && !elements.has(id)) elements.set(id, match[0])
  }
  return elements
}

/** 下一个不与已有 id 冲突的编号 id。 */
function nextWordNumberingId(ids: Iterable<string>): number {
  let next = 1
  for (const id of ids) {
    const value = Number.parseInt(id, 10)
    if (Number.isFinite(value) && value >= next) next = value + 1
  }
  return next
}

/** 正文引用到的编号 id（w:numPr 里的 w:numId）。 */
export function collectWordNumberingReferences(childrenXml: string): string[] {
  return [
    ...new Set(
      [...childrenXml.matchAll(/<w:numId\b[^>]*\bw:val="([^"]+)"/g)].map((match) => match[1] ?? '')
    ),
  ].filter(Boolean)
}

/** 一次性改写正文里的编号引用；逐条替换会让「1→3」与「3→4」互相踩到。 */
function replaceWordNumberingReferences(
  childrenXml: string,
  renames: ReadonlyMap<string, string>
): string {
  return childrenXml.replace(
    /(<w:numId\b[^>]*\bw:val=")([^"]+)(")/g,
    (match, prefix: string, id: string, suffix: string) => {
      const renamed = renames.get(id)
      return renamed ? `${prefix}${renamed}${suffix}` : match
    }
  )
}

/** 替换元素开标签上的某个属性值（只改第一处，即开标签那一处）。 */
function replaceWordXmlAttribute(xml: string, attribute: string, value: string): string {
  return xml.replace(new RegExp(`\\b${escapeRegExp(attribute)}="[^"]*"`), `${attribute}="${value}"`)
}

/** 把 XML 根标签上缺的命名空间声明从捐赠方补齐；补不出来就拒绝，不写半份坏文档。 */
function ensureXmlRootNamespaces(targetXml: string, donorXml: string, addedXml: string): string {
  const targetRoot = /<([A-Za-z][\w:.-]*)(\s[^>]*)?>/.exec(targetXml)
  const donorRoot = /<([A-Za-z][\w:.-]*)(\s[^>]*)?>/.exec(donorXml)
  if (!targetRoot || !donorRoot) return targetXml
  const declared = new Set(
    [...targetRoot[0].matchAll(/xmlns:([A-Za-z0-9]+)=/g)].map((match) => match[1] ?? '')
  )
  const used = new Set<string>()
  for (const match of addedXml.matchAll(/<\/?([A-Za-z0-9]+):/g)) used.add(match[1] ?? '')
  for (const match of addedXml.matchAll(/\s([A-Za-z0-9]+):[A-Za-z0-9]+\s*=/g)) used.add(match[1] ?? '')
  const missing = [...used].filter((prefix) => !!prefix && !declared.has(prefix))
  if (isEmpty(missing)) return targetXml

  const declarations = missing.map((prefix) => {
    const uri = new RegExp(`xmlns:${prefix}="([^"]*)"`).exec(donorRoot[0])?.[1]
    if (!isString(uri))
      throw new AppError(
        'VALIDATION',
        `追加内容用到了未声明的 XML 命名空间前缀 ${prefix}，已放弃写入以免损坏文档。`
      )
    return ` xmlns:${prefix}="${uri}"`
  })
  return targetXml.replace(targetRoot[0], `${targetRoot[0].slice(0, -1)}${declarations.join('')}>`)
}

/** w:numbering 的次序要求：所有 w:abstractNum 在前，所有 w:num 在后。 */
function insertWordNumberingParts(
  numberingXml: string,
  abstractAdditions: string[],
  numAdditions: string[]
): string {
  const closeTag = '</w:numbering>'
  if (!numberingXml.includes(closeTag))
    throw new AppError('VALIDATION', '目标 Word 文档的编号定义结构不完整，无法追加列表。')
  const firstNumIndex = numberingXml.search(/<w:num\s/)
  const abstractAt = firstNumIndex >= 0 ? firstNumIndex : numberingXml.lastIndexOf(closeTag)
  const withAbstract = `${numberingXml.slice(0, abstractAt)}${abstractAdditions.join('')}${numberingXml.slice(abstractAt)}`
  const closeIndex = withAbstract.lastIndexOf(closeTag)
  return `${withAbstract.slice(0, closeIndex)}${numAdditions.join('')}${withAbstract.slice(closeIndex)}`
}

/**
 * 把片段的编号定义并进目标文档，并改写正文里的引用。
 *
 * 判据（§5.3b ①算法与协议）：`w:numId` 与 relationship id 一样是**每文档局部的**。docx 库给
 * 片段里的项目符号一律发 `numId=1`，正文直接缝进目标文档有两种坏法——目标没有这条定义时，
 * 列表退化成普通段落（用户看到的是「项目符号没了」）；目标有同号定义时，追加的列表会**串到
 * 别人的列表上**（接着人家的序号往下编）。所以整条定义（`w:num` 与它指向的 `w:abstractNum`）
 * 连带重发号搬过去，正文引用一次性改写。目标压根没有编号部件时直接用片段那份：此时不存在冲突，
 * 也就没有重发号的必要（顺带省掉一次全文改写）。
 *
 * 返回的 `numberingXml` 为 null 表示「不必动目标的编号部件」。
 */
export function mergeWordNumberingDefinitions(input: {
  existingNumberingXml: Nullable<string>
  fragmentNumberingXml: Nullable<string>
  fragmentChildrenXml: string
}): { numberingXml: Nullable<string>; fragmentChildrenXml: string } {
  const references = collectWordNumberingReferences(input.fragmentChildrenXml)
  if (isEmpty(references) || !input.fragmentNumberingXml)
    return { numberingXml: null, fragmentChildrenXml: input.fragmentChildrenXml }
  if (!input.existingNumberingXml)
    return {
      numberingXml: input.fragmentNumberingXml,
      fragmentChildrenXml: input.fragmentChildrenXml,
    }

  const fragmentNums = readWordXmlElements(input.fragmentNumberingXml, 'w:num', 'w:numId')
  const fragmentAbstractNums = readWordXmlElements(
    input.fragmentNumberingXml,
    'w:abstractNum',
    'w:abstractNumId'
  )
  let nextNumId = nextWordNumberingId(
    readWordXmlElements(input.existingNumberingXml, 'w:num', 'w:numId').keys()
  )
  let nextAbstractNumId = nextWordNumberingId(
    readWordXmlElements(input.existingNumberingXml, 'w:abstractNum', 'w:abstractNumId').keys()
  )
  const abstractAdditions: string[] = []
  const numAdditions: string[] = []
  const renames = new Map<string, string>()

  for (const reference of references) {
    const numXml = fragmentNums.get(reference)
    // 片段自己都没有这条定义：搬不了，保持原样（与修复前同样的退化，不新增失败）。
    if (!numXml) continue
    const abstractNumId = /<w:abstractNumId\b[^>]*\bw:val="([^"]+)"/.exec(numXml)?.[1]
    const abstractXml = isString(abstractNumId) ? fragmentAbstractNums.get(abstractNumId) : undefined
    const newNumId = String(nextNumId)
    nextNumId += 1
    let numberedXml = replaceWordXmlAttribute(numXml, 'w:numId', newNumId)
    if (abstractXml) {
      const newAbstractNumId = String(nextAbstractNumId)
      nextAbstractNumId += 1
      abstractAdditions.push(
        replaceWordXmlAttribute(abstractXml, 'w:abstractNumId', newAbstractNumId)
      )
      numberedXml = numberedXml.replace(
        /(<w:abstractNumId\b[^>]*\bw:val=")([^"]+)(")/,
        `$1${newAbstractNumId}$3`
      )
    }
    numAdditions.push(numberedXml)
    renames.set(reference, newNumId)
  }
  if (isEmpty(numAdditions))
    return { numberingXml: null, fragmentChildrenXml: input.fragmentChildrenXml }

  const additions = [...abstractAdditions, ...numAdditions].join('')
  return {
    numberingXml: insertWordNumberingParts(
      ensureXmlRootNamespaces(input.existingNumberingXml, input.fragmentNumberingXml, additions),
      abstractAdditions,
      numAdditions
    ),
    fragmentChildrenXml: replaceWordNumberingReferences(input.fragmentChildrenXml, renames),
  }
}

/** 正文引用到的样式 id（段落、字符、表格样式）。 */
export function collectWordStyleReferences(childrenXml: string): string[] {
  return [
    ...new Set(
      [...childrenXml.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\b[^>]*\bw:val="([^"]+)"/g)].map(
        (match) => match[1] ?? ''
      )
    ),
  ].filter(Boolean)
}

/** 一条样式定义还依赖哪些样式。 */
function collectWordStyleDependencies(styleXml: string): string[] {
  return [...styleXml.matchAll(/<w:(?:basedOn|next|link)\b[^>]*\bw:val="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter(Boolean)
}

/**
 * 把片段里目标文档缺的样式定义补过去；同名样式**一律不覆盖**。
 *
 * 追加的标题段落引用的是 `Heading1` 这类样式 id，目标文档没有同名定义时 Word 按普通正文渲染
 * （用户看到的是「标题没了」）。反过来，目标已有同名样式时要用目标那份：追加的内容应当跟着
 * 宿主文档的观感走，而不是把人家的标题样式改成片段的样子。
 */
export function mergeWordStyleDefinitions(input: {
  existingStylesXml: Nullable<string>
  fragmentStylesXml: Nullable<string>
  fragmentChildrenXml: string
}): Nullable<string> {
  const references = collectWordStyleReferences(input.fragmentChildrenXml)
  if (isEmpty(references) || !input.fragmentStylesXml) return null
  if (!input.existingStylesXml) return input.fragmentStylesXml

  const fragmentStyles = readWordXmlElements(input.fragmentStylesXml, 'w:style', 'w:styleId')
  const existingStyles = readWordXmlElements(input.existingStylesXml, 'w:style', 'w:styleId')
  const pending = [...references]
  const visited = new Set<string>()
  const additions: string[] = []
  while (!isEmpty(pending)) {
    const styleId = pending.shift() ?? ''
    if (!styleId || visited.has(styleId) || existingStyles.has(styleId)) continue
    visited.add(styleId)
    const styleXml = fragmentStyles.get(styleId)
    if (!styleXml) continue
    additions.push(styleXml)
    pending.push(...collectWordStyleDependencies(styleXml))
  }
  if (isEmpty(additions)) return null

  const merged = ensureXmlRootNamespaces(
    input.existingStylesXml,
    input.fragmentStylesXml,
    additions.join('')
  )
  const closeTag = '</w:styles>'
  const closeIndex = merged.lastIndexOf(closeTag)
  if (closeIndex < 0)
    throw new AppError('VALIDATION', '目标 Word 文档的样式定义结构不完整，无法追加样式。')
  return `${merged.slice(0, closeIndex)}${additions.join('')}${merged.slice(closeIndex)}`
}

/** 新部件的内容类型登记；已登记或没有清单时原样返回。 */
export function registerWordPartContentType(
  contentTypesXml: Nullable<string>,
  part: { path: string; contentType: string }
): Nullable<string> {
  if (!contentTypesXml) return null
  const partName = `/${part.path}`
  if (contentTypesXml.includes(`PartName="${partName}"`)) return contentTypesXml
  const closeTag = '</Types>'
  const closeIndex = contentTypesXml.lastIndexOf(closeTag)
  if (closeIndex < 0)
    throw new AppError('VALIDATION', '目标 Word 文档的内容类型清单不完整，无法登记新部件。')
  const override = `<Override PartName="${partName}" ContentType="${part.contentType}"/>`
  return `${contentTypesXml.slice(0, closeIndex)}${override}${contentTypesXml.slice(closeIndex)}`
}

/** 新部件与 document.xml 的关系登记；已有同类型关系时原样返回。 */
export function registerWordPartRelationship(
  relationshipsXml: string,
  part: { path: string; relationshipType: string }
): string {
  if (relationshipsXml.includes(`Type="${part.relationshipType}"`)) return relationshipsXml
  const closeTag = '</Relationships>'
  const closeIndex = relationshipsXml.lastIndexOf(closeTag)
  if (closeIndex < 0)
    throw new AppError('VALIDATION', 'Word 文档关系文件结构不完整，无法登记新部件。')
  const id = createUniqueWordRelationshipId(collectWordRelationshipIds(relationshipsXml))
  const target = part.path.replace(/^word\//, '')
  const relationship = `<Relationship Id="${id}" Type="${part.relationshipType}" Target="${target}"/>`
  return `${relationshipsXml.slice(0, closeIndex)}${relationship}${relationshipsXml.slice(closeIndex)}`
}

/** 没有 relationships 文件时创建最小空关系 XML。 */
export function createEmptyWordDocumentRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '</Relationships>',
  ].join('')
}

/** 正则转义。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
