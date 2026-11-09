import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ProjectCodeIndexApi,
  ProjectLanguageSkillHost,
  ProjectOperationContext,
  ProjectSpacePort,
} from '../../contract/requires.js'
import type { ProjectLanguageSkillOwner } from '../../types/language-skills.js'
import type { ProjectCodeQuery } from '../../types/project.js'

import { createProjectCodeQuery } from './ProjectCodeQuery.js'

/** 已固定语言目录的代码查询，在每次派发前重新核对授权并激活真实所有者。 */
export interface SkillProjectCodeQueryApi {
  /** 复用项目语言查询与宿主代码图谱，不绕过原有项目端口。 */
  run(input: ProjectCodeQuery, context: ProjectOperationContext): Promise<unknown>
}

class SkillProjectCodeQuery implements SkillProjectCodeQueryApi {
  private static readonly languagePrefix = 'project:language:'
  private readonly owners: readonly ProjectLanguageSkillOwner[]
  private readonly query: ProjectSpacePort['queryCode']

  public constructor(
    codeIndex: ProjectCodeIndexApi,
    private readonly skills: ProjectLanguageSkillHost
  ) {
    this.owners = (skills.session?.catalog ?? skills.lease.skills)
      .filter((owner) =>
        owner.grants.some((grant) => grant.startsWith(SkillProjectCodeQuery.languagePrefix))
      )
      .map((owner) => ({
        manifest: { name: owner.manifest.name },
        generation: owner.generation,
        grants: [...owner.grants],
      }))
    this.query = createProjectCodeQuery(
      codeIndex,
      this.owners.flatMap((owner) =>
        owner.grants
          .filter((grant) => grant.startsWith(SkillProjectCodeQuery.languagePrefix))
          .map((grant) => grant.slice(SkillProjectCodeQuery.languagePrefix.length))
      )
    )
  }

  public async run(input: ProjectCodeQuery, context: ProjectOperationContext): Promise<unknown> {
    context.abortSignal.throwIfAborted()
    const grants = new Set(
      this.owners.flatMap((owner) =>
        owner.grants.filter((grant) => grant.startsWith(SkillProjectCodeQuery.languagePrefix))
      )
    )
    const selected = new Map<string, ProjectLanguageSkillOwner>()
    for (const grant of grants) {
      const owners = this.owners.filter((owner) => owner.grants.includes(grant))
      const checks = await Promise.allSettled(
        owners.map((owner) =>
          this.skills.registry.assertGranted(owner.manifest.name, owner.generation, grant)
        )
      )
      context.abortSignal.throwIfAborted()
      const available = owners.filter((_, index) => checks[index]!.status === 'fulfilled')
      if (isEmpty(available)) throw new AppError('PERMISSION', `语言 Skill 授权已失效：${grant}`)
      const owner =
        available.find((candidate) =>
          this.skills.session?.skills.some(
            (active) =>
              active.manifest.name === candidate.manifest.name &&
              active.generation === candidate.generation
          )
        ) ?? available[0]!
      selected.set(`${owner.manifest.name}\0${owner.generation}`, owner)
    }
    for (const owner of selected.values()) {
      await this.skills.session?.activate(owner.manifest.name, context.abortSignal)
      context.abortSignal.throwIfAborted()
    }
    return this.query(input, context)
  }
}

/** 将宿主明确选择的 Skill 语言授权接到已有项目代码查询，保留按调用授权和按需激活。 */
export function createSkillProjectCodeQuery(
  codeIndex: ProjectCodeIndexApi,
  skills: ProjectLanguageSkillHost
): ProjectSpacePort['queryCode'] {
  const query = new SkillProjectCodeQuery(codeIndex, skills)
  return (input, context) => query.run(input, context)
}
