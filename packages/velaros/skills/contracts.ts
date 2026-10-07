export { BuiltinSkillNames, SkillLimits } from './contract/constants.js'
export type { SkillCompositionApi } from './contract/provides.js'
export { VelarSkillsModule } from './contract/surface.js'
export { skillComposition } from './impl/SkillComposition.js'
export type {
  SkillActivation,
  SkillCapability,
  SkillContribution,
  SkillDirectoryInput,
  SkillGuide,
  SkillGuideInput,
  SkillInstallRequest,
  SkillLoaded,
  SkillManifest,
  SkillMutation,
  SkillNameInput,
  SkillRecord,
  SkillSelection,
  SkillSummary,
} from './types/skills.js'
