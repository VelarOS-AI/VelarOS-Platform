/**
 * 接缝的探针：`velar:knowledge` 空间端口上的三个知识方法，宿主要能把知识库引擎的领域门面直接转过去。
 * 两边各写各的形状（velar 单元不依赖引擎包），引擎改了字段、端口多要了字段，这个文件就编译不过；
 * `knowledge-port-conformance.test.ts` 编译它并断言零诊断。
 */

import type { KnowledgeDomainApi } from '../../../packages/knowledge/src/contract/provides.js'
import type { KnowledgeSpacePort } from '../../../packages/velar/knowledge/contract/requires.js'

declare const domain: KnowledgeDomainApi

export const knowledgeMethods: Pick<KnowledgeSpacePort, 'getDiagnostics' | 'ensureWorkspaceSynced' | 'searchKnowledge'> = domain
