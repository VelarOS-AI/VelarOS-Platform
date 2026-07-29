import {
  DefaultMemoryRuntime,
  type MemoryTreeRuntimeProviders,
} from '../src'

declare const providers: MemoryTreeRuntimeProviders

const memory = new DefaultMemoryRuntime(providers)

memory.memoryDomainService.captureEvidence({
  scopeId: 'user:demo',
  scopeType: 'global',
  sourceType: 'import',
  trustLevel: 'user_stated',
  content: '用户偏好简洁的技术说明。',
})

const items = memory.domain.recall('技术说明偏好')
console.info(items)
