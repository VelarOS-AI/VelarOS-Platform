/** PPTX 预览只读需要的 OOXML 清单、内部部件关系与 DrawingML 文本；命名空间按 URI 判断。 */

import { DOMParser } from '@xmldom/xmldom'

import { AppError } from '@velaros-ai/core/error'

import { officeError } from '../errors.js'

/** OPC 关系部件的命名空间，Strict 与 Transitional 共用。 */
const PackageRelationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** PresentationML 的 Transitional 与 Strict 命名空间。 */
const PresentationNamespaces = Object.freeze([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
])

/** Office 文档关系属性与类型的 Transitional 与 Strict 命名空间。 */
const OfficeRelationshipNamespaces = Object.freeze([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])

/** DrawingML 文本的 Transitional 与 Strict 命名空间。 */
const DrawingNamespaces = Object.freeze([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
])

/** 从包级 officeDocument 关系定位演示文稿主部件，不依赖固定的 ppt/presentation.xml 名字。 */
export function pptxPresentationPath(packageRelationshipsXml: string): string {
  const relationships = readPptxRelationships(packageRelationshipsXml, '_rels/.rels')
  const main = [...relationships.values()].filter((relationship) =>
    hasOfficeRelationshipType(relationship, 'officeDocument')
  )
  if (main.length !== 1)
    throw officeError('VALIDATION', 'PPTX 必须有唯一的包级 officeDocument 关系。')
  return resolvePptxRelationshipTarget('', main[0]!)
}

/** 主部件的关系部件在同目录的 _rels 内，关系目标仍相对主部件本身解析。 */
export function pptxRelationshipsPath(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`
}

/** 按主部件 sldIdLst 的文档顺序交回真实幻灯片部件；未列入清单的孤立部件不算页。 */
export function pptxSlidePaths(
  presentationXml: string,
  relationshipsXml: string | undefined,
  presentationPath: string
): string[] {
  const root = readPptxXml(presentationXml, presentationPath)
  requirePresentationElement(root, 'presentation', presentationPath)
  const lists = pptxChildElements(root).filter(
    (element) => element.localName === 'sldIdLst' && isPresentationElement(element)
  )
  if (lists.length > 1)
    throw officeError('VALIDATION', `PPTX 主部件 ${presentationPath} 含多个幻灯片清单。`)
  const entries = lists[0] ? pptxChildElements(lists[0]) : []
  if (entries.length === 0) return []
  if (relationshipsXml === undefined)
    throw officeError('VALIDATION', `PPTX 主部件 ${presentationPath} 的幻灯片关系部件不存在。`)
  const relationships = readPptxRelationships(
    relationshipsXml,
    pptxRelationshipsPath(presentationPath)
  )
  return entries.map((element) => {
    requirePresentationElement(element, 'sldId', presentationPath)
    const ids = OfficeRelationshipNamespaces.map((namespace) =>
      element.getAttributeNS(namespace, 'id')
    ).filter(Boolean)
    const relationship = ids.length === 1 ? relationships.get(ids[0]!) : undefined
    if (!relationship || !hasOfficeRelationshipType(relationship, 'slide'))
      throw officeError(
        'VALIDATION',
        `PPTX 主部件 ${presentationPath} 的幻灯片关系缺失或类型不对。`
      )
    return resolvePptxRelationshipTarget(presentationPath, relationship)
  })
}

/** 从实际幻灯片的 DrawingML 文本节点按文档顺序取字，前缀、实体和 CDATA 交给 XML 解析器。 */
export function extractPptxDrawingText(xml: string, partPath: string): string[] {
  const root = readPptxXml(xml, partPath)
  requirePresentationElement(root, 'sld', partPath)
  return Array.from(root.getElementsByTagNameNS('*', 't'))
    .filter((element) => DrawingNamespaces.includes(element.namespaceURI ?? ''))
    .map((element) => (element.textContent ?? '').trim())
}

/** 只用 XML 模式建树；解析器不装载外部资源，DOCTYPE 和全部解析诊断都拒绝。 */
function readPptxXml(xml: string, partPath: string): Element {
  const diagnostics: string[] = []
  let document: Document
  try {
    document = new DOMParser({
      errorHandler: {
        warning: (message) => diagnostics.push(String(message)),
        error: (message) => diagnostics.push(String(message)),
        fatalError: (message) => diagnostics.push(String(message)),
      },
    }).parseFromString(xml, 'application/xml')
  } catch (error) {
    throw new AppError('VALIDATION', `PPTX 部件 ${partPath} 的 XML 无法解析。`, error, {
      executionOutcome: 'not-applied',
    })
  }
  if (diagnostics.length > 0 || !document?.documentElement || document.doctype)
    throw officeError(
      'VALIDATION',
      `PPTX 部件 ${partPath} 的 XML 含解析诊断、DOCTYPE 或缺少根元素。`
    )
  return document.documentElement
}

/** 关系 Id 在单个关系部件中唯一；只读取 OPC 命名空间的直接 Relationship 子元素。 */
function readPptxRelationships(xml: string, partPath: string): Map<string, Element> {
  const root = readPptxXml(xml, partPath)
  if (root.localName !== 'Relationships' || root.namespaceURI !== PackageRelationshipsNamespace)
    throw officeError('VALIDATION', `PPTX 关系部件 ${partPath} 的根元素不对。`)
  const relationships = new Map<string, Element>()
  for (const relationship of pptxChildElements(root)) {
    if (
      relationship.localName !== 'Relationship' ||
      relationship.namespaceURI !== PackageRelationshipsNamespace
    )
      throw officeError('VALIDATION', `PPTX 关系部件 ${partPath} 含无效的关系元素。`)
    const id = relationship.getAttribute('Id')
    if (!id || relationships.has(id))
      throw officeError('VALIDATION', `PPTX 关系部件 ${partPath} 的关系 Id 缺失或重复。`)
    relationships.set(id, relationship)
  }
  return relationships
}

/** Office 关系类型允许两套标准 URI，不依赖关系 Id 或 XML 前缀的命名习惯。 */
function hasOfficeRelationshipType(relationship: Element, type: string): boolean {
  return OfficeRelationshipNamespaces.some(
    (namespace) => relationship.getAttribute('Type') === `${namespace}/${type}`
  )
}

/** OPC 内部目标按源部件目录解析，拒绝外部地址、查询片段和越过包根的路径。 */
function resolvePptxRelationshipTarget(sourcePartPath: string, relationship: Element): string {
  const mode = relationship.getAttribute('TargetMode')
  const target = relationship.getAttribute('Target')
  if (
    (mode && mode !== 'Internal') ||
    !target ||
    target.includes('\\') ||
    target.startsWith('//') ||
    /[?#]/.test(target) ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  )
    throw officeError(
      'VALIDATION',
      `PPTX 部件 ${sourcePartPath || '/'} 的关系目标必须是包内的部件路径。`
    )
  const segments = target.startsWith('/') ? [] : sourcePartPath.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw officeError('VALIDATION', 'PPTX 的内部关系目标越过了包根。')
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0) throw officeError('VALIDATION', 'PPTX 的内部关系没有指向部件。')
  return segments.join('/')
}

/** 只取元素直接子节点，避免把嵌套的同名元素误当主清单或关系。 */
function pptxChildElements(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1)
}

/** PresentationML 身份由命名空间 URI 决定。 */
function isPresentationElement(element: Element): boolean {
  return PresentationNamespaces.includes(element.namespaceURI ?? '')
}

/** 主清单和实际页都必须具有对应的 PresentationML 根身份。 */
function requirePresentationElement(element: Element, name: string, partPath: string): void {
  if (element.localName !== name || !isPresentationElement(element))
    throw officeError('VALIDATION', `PPTX 部件 ${partPath} 缺少有效的 ${name} 元素。`)
}
