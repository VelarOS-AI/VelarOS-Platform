import { skillCapabilityModules } from '../../../../dist/skills/index.js'

/** 测试产品明确选择 Skill 模块，并把其 Node 租约与能力装配在一起。 */
export async function withSkillFixture(options, skills) {
  const modules = await skillCapabilityModules.create({ ...skills, node: options.node })
  return {
    ...options,
    modules: [...(options.modules ?? []), ...modules],
    moduleAccess(sessionId, module) {
      const catalog = skills.session?.catalog ?? skills.lease.skills
      const active = skills.session?.skills ?? skills.lease.skills
      const selected =
        !catalog.some((skill) => skill.grants.includes(module)) ||
        active.some((skill) => skill.grants.includes(module))
      return selected && (options.moduleAccess?.(sessionId, module) ?? true)
    },
  }
}
