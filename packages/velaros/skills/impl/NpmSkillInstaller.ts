import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isObject } from '@velaros-ai/core'

import type { NpmClientApi } from '../../execution/index.js'
import { createNpmClient } from '../../execution/local.js'
import type { NpmSkillInstallerOptions, SkillDependencyInstaller } from '../contract/requires.js'

/** Skill 只决定使用安装或锁文件恢复；npm 进程生命周期由 execution 统一管理。 */
class NpmSkillInstaller implements SkillDependencyInstaller {
  private readonly npm: NpmClientApi

  public constructor(options: NpmSkillInstallerOptions) {
    this.npm = createNpmClient(options)
  }

  public async install(
    directory: string,
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    let locked = true
    try {
      await stat(join(directory, 'package-lock.json'))
    } catch (error) {
      if (!isObject(error) || !('code' in error) || error.code !== 'ENOENT') throw error
      locked = false
    }
    if (locked) await this.npm.restore(directory, allowScripts, signal)
    else await this.npm.install(directory, [], allowScripts, signal)
  }
}

/** Skill 和自管 npm 环境共用安装执行机制。 */
export function createNpmSkillInstaller(
  options: NpmSkillInstallerOptions
): SkillDependencyInstaller {
  return new NpmSkillInstaller(options)
}
