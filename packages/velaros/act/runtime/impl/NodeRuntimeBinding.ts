import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'

import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { nodeExecutable } from '@velaros-ai/script'

import type { NodeRuntimeBindingOptions, RuntimeSessionBinding } from '../contract/requires.js'

/** 解析 Node 环境事实，不创建 Host、执行器或存储。 */
export interface NodeRuntimeBindingApi {
  /** 与正式 Node 装配共享同一身份算法。 */
  resolve(options: NodeRuntimeBindingOptions): Promise<RuntimeSessionBinding>
}

class NodeRuntimeBinding implements NodeRuntimeBindingApi {
  public async resolve(options: NodeRuntimeBindingOptions): Promise<RuntimeSessionBinding> {
    if (
      !isNonBlankString(options.cwd) ||
      !isAbsolute(options.cwd) ||
      !isNonBlankString(options.binding?.executionIdentity) ||
      !isNonBlankString(options.binding?.authorizationScope)
    )
      throw new AppError(
        'VALIDATION',
        '需要绝对 cwd 和已核验的 executionIdentity、authorizationScope'
      )
    const cwd = await realpath(options.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new AppError('VALIDATION', 'cwd 必须是已有目录')
    const executable = options.executable ?? nodeExecutable.resolve()
    if (!executable) throw new AppError('UNAVAILABLE', '需要真实 Node.js 可执行文件')
    const user = userInfo()
    return {
      executionIdentity: createHash('sha256')
        .update(
          JSON.stringify({
            identity: options.binding.executionIdentity,
            cwd,
            user: { name: user.username, uid: user.uid, gid: user.gid },
            executable: await realpath(executable),
          })
        )
        .digest('hex'),
      authorizationScope: createHash('sha256')
        .update(
          JSON.stringify({
            scope: options.binding.authorizationScope,
            confinement: options.processConfinement ?? null,
          })
        )
        .digest('hex'),
    }
  }
}

/** 为 Node 创建和持久控制解析同一执行边界，解析过程不取得进程所有权。 */
export async function resolveNodeRuntimeBinding(
  options: NodeRuntimeBindingOptions
): Promise<RuntimeSessionBinding> {
  return new NodeRuntimeBinding().resolve(options)
}
