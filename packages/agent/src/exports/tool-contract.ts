export { fileContextFor } from '../impl/context/FileContextCoordinator'
export type {
  ApprovalPort,
  ManualApprovalOptions,
  UnattendedApprovalEscalationHooks,
} from '../impl/tools/DefaultDenyApprovalPort'
export {
  createManualApprovalOptions,
  createUnattendedSubAgentApprovalPort,
  defaultDenyApprovalPort,
} from '../impl/tools/DefaultDenyApprovalPort'
export {
  DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  serializeToolExampleInput,
  ToolContractExampleRegistry,
} from '../impl/tools/ToolContractExampleRegistry'
export type { ToolInputReuseOptions } from '../impl/tools/ToolInputReuseStore'
export {
  resolveToolInputReuse,
  ToolInputReuseSchema,
  withToolInputReuse,
} from '../impl/tools/ToolInputReuseStore'
export type { InteractionPort } from '../impl/tools/UnsupportedInteractionPort'
export { defaultUnsupportedInteractionPort } from '../impl/tools/UnsupportedInteractionPort'
export type {
  FileContextCarrier,
  FileContextRange,
  FileContextSnapshot,
  FileContextSource,
} from '../types/resource-contracts'
export type {
  DefineToolContractInput,
  DefineToolContractSurfaceInput,
  DefineToolRuntimeSpecInput,
  NonEmptyToolContractList,
  ToolContractDescriptionSpec,
  ToolContractExecute,
  ToolContractRole,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
  ToolInputReuseContract,
  ToolInputReuseMigrationRequest,
} from '../types/tool-contract'
export type {
  ToolCallableOperationsOptions,
  ToolContextResolver,
} from '../utils/toolkit/callable-operations'
export {
  createToolCallableOperations,
  parseToolWireInput,
} from '../utils/toolkit/callable-operations'
export type { ToolConceptRegistry } from '../utils/toolkit/concepts'
export {
  createToolConceptLookup,
  defineToolConcepts,
  globalToolConcept,
  GlobalToolConcepts,
} from '../utils/toolkit/concepts'
export {
  buildToolContractDescription,
  defineToolContract,
  defineToolRuntimeSpec,
  isToolContractSpec,
  resolveToolReadOnly,
} from '../utils/toolkit/define-tool-contract'
export {
  readToolSchemaDiscoveryNames,
  ToolContractDiscoveryDescriptors,
} from '../utils/toolkit/discovery'
export type { AppliedAdjustment } from '../utils/toolkit/forgiving-schema'
export {
  buildAppliedAdjustments,
  buildValidItemsHint,
  clampedInt,
  emptyIsNoop,
  inferActionFromFields,
  preferFirst,
  withDefaultNote,
} from '../utils/toolkit/forgiving-schema'
export {
  assertCanonicalToolId,
  CanonicalToolIdPattern,
  isCanonicalToolId,
} from '../utils/toolkit/identity'
export type {
  CreateToolSchemaBundleOptions,
  ToolSchemaBundle,
  ToolSchemaSource,
} from '../utils/toolkit/schema-bundle'
export {
  canonicalizeProviderInputSchema,
  createToolSchemaBundle,
  schemaToInputSchema,
} from '../utils/toolkit/schema-bundle'
export { createApprovalOperationKey, createTaskApprovalPort } from '../utils/toolkit/task-approval'
export type {
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolDescriptionBudgetWaiver,
  ToolDescriptionBudgetWaiverReason,
  ToolDescriptionDetail,
} from '../utils/toolkit/tool-description'
export {
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  compactStructuredToolDescription,
  isStructuredParameterDescription,
  isStructuredToolDescription,
  parseStructuredToolDescription,
  renderParameterDescription,
  renderToolDescription,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
  structureToolDescriptionsForCategory,
  ToolDescriptionBudgetChars,
  ToolDescriptionMaxChars,
} from '../utils/toolkit/tool-description'
export {
  applyDefaultRecursiveMaxDepth,
  optionalReadEndLine,
  optionalReadMaxChars,
  optionalReadStartLine,
  refineBoundedReadInput,
  requiredNonNegativeMaxDepth,
  requiredPositiveMaxDepth,
  requiredResultLimit,
  ToolInputBoundMessages,
  withReadBoundJsonSchemaConstraints,
} from '../utils/toolkit/tool-input-bounds'
