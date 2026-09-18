// 能力单元的 contracts 入口是浏览器与渲染进程加载的那一份：打成浏览器包必须不碰 Node。
export { ComputerErrorCodes, ComputerInputLimits } from '@velaros-ai/velar/computer/contracts'
export { KnowledgeSourceKinds, VelarKnowledgeModule } from '@velaros-ai/velar/knowledge/contracts'
export { MemoryEvidenceCategories, VelarMemoryModule } from '@velaros-ai/velar/memory/contracts'
