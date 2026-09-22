// 能力单元的 contracts 入口是浏览器与渲染进程加载的那一份：打成浏览器包必须不碰 Node。
export { ComputerErrorCodes, ComputerInputLimits } from '@velaros-ai/velaros/computer/contracts'
export { MemoryLimits, MemoryTypes, VelarMemoryModule } from '@velaros-ai/velaros/memory/contracts'
export { OfficeErrorCodes, OfficeInputLimits, VelarOfficeModule } from '@velaros-ai/velaros/office/contracts'
export { LanguageServiceIds, CodeQuerySources, DevelopmentCodeLimits, BuiltinExternalLanguageServers } from '@velaros-ai/velaros/project/contracts'
export type { ExternalLanguageServerSpec, ExternalLanguageDiagnostic, ExternalLanguageStatus, ExternalLanguageLocation, ExternalLanguageHover } from '@velaros-ai/velaros/project/contracts'
