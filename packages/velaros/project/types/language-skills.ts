/** 为项目语言服务显式授予能力的固定 Skill 身份，不包含包加载行为。 */
export interface ProjectLanguageSkillOwner {
  /** 已审核包的逻辑身份。 */
  readonly manifest: {
    /** Skill 名称。 */
    readonly name: string
  }
  /** 已审核内容的固定代际。 */
  readonly generation: string
  /** 本次宿主已授予的能力；项目只读取 project:language: 前缀。 */
  readonly grants: readonly string[]
}
