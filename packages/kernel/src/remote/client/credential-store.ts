// Platform Kernel owns the host-neutral remote-node implementation.
// 域:设备凭据的落盘实现。
//
// 私钥是这条跨机链路上唯一的长期秘密,也是本文件唯一真正的约束来源:
//  - **不进日志**:所有诊断只带路径与 clientId,任何分支都不打印 key 本体。
//  - **不世界可读**:文件 0600、目录 0700;先写临时文件再 rename,不留半截可读的中间态。
//  - **坏了就当没有**:解析失败一律回 `null`,让人重走配对仪式。带着半信半疑的凭据继续连,
//    换来的只是一串看不懂的 4002。
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { isNonBlankString, isObject, Log } from '@velaros-ai/core'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'
import { RemoteNodeIdentitySchema } from '@velaros-ai/kernel/contracts/protocol'

import type {
  RemoteNodeCredentials,
  RemoteNodeCredentialStore,
} from './contracts'

const log = Log.tag('RemoteNodeCredentials')

const CredentialFileMode = 0o600
const CredentialDirectoryMode = 0o700

/**
 * 落盘形状。
 *
 * `schemaVersion` 是显式版本位:将来换 Electron `safeStorage` 密封后,旧明文文件靠它被认出来
 * 并迁移,而不是靠字段猜。`strictObject` 让多余字段直接判失败——凭据文件不接受"顺带塞点别的"。
 */
const StoredRemoteNodeCredentialsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.string().min(1),
  privateKey: z.string().min(1),
  publicKey: z.string().min(1),
  node: RemoteNodeIdentitySchema,
})

/** 默认落点:每台远端主机一份,按 slug 分文件,互不影响。 */
export function defaultRemoteNodeCredentialsPath(
  hostSlug: string,
  home = process.env.HOME,
): string {
  const root = isNonBlankString(home) ? home.trim() : '/tmp'
  return join(root, '.velaros', 'remote-nodes', `${hostSlug}.json`)
}

/**
 * 明文文件实现。
 *
 * 端口只有 load/save/clear 三个动作,Desktop 后续换成 `safeStorage` 密封版时只替换本类,
 * `RemoteNodeClient` 一行都不动。
 */
export class FileRemoteNodeCredentialStore implements RemoteNodeCredentialStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<Nullable<RemoteNodeCredentials>> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      // 文件不存在是正常起点(尚未配对),其余读失败按同样的"没有凭据"处理但要出声。
      if (!isFileNotFound(error)) {
        log.warn('Remote node credentials could not be read', {
          error,
          path: this.filePath,
        })
      }
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      log.warn('Remote node credentials are not valid JSON; treating the host as unpaired', {
        error,
        path: this.filePath,
      })
      return null
    }

    const result = StoredRemoteNodeCredentialsSchema.safeParse(parsed)
    if (!result.success) {
      log.warn('Remote node credentials do not match the expected shape; treating the host as unpaired', {
        path: this.filePath,
      })
      return null
    }
    return {
      clientId: result.data.clientId,
      node: result.data.node,
      privateKey: result.data.privateKey,
      publicKey: result.data.publicKey,
    }
  }

  public async save(credentials: RemoteNodeCredentials): Promise<void> {
    // 目录先按 0700 建好:原子写只保证文件位,父目录权限得自己钉。
    await mkdir(dirname(this.filePath), {
      mode: CredentialDirectoryMode,
      recursive: true,
    })
    await writeJsonFileAtomically(
      this.filePath,
      {
        schemaVersion: 1,
        clientId: credentials.clientId,
        node: credentials.node,
        privateKey: credentials.privateKey,
        publicKey: credentials.publicKey,
      } satisfies z.infer<typeof StoredRemoteNodeCredentialsSchema>,
      { mode: CredentialFileMode, space: 2, trailingNewline: true },
    )
    log.info('Remote node credentials stored', {
      clientId: credentials.clientId,
      nodeId: credentials.node.nodeId,
    })
  }

  public async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && Reflect.get(error, 'code') === 'ENOENT'
}
