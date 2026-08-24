// Platform Kernel owns the host-neutral remote-node implementation.
// 文件落盘的凭据实现。单一凭据面:同一时刻只服务一台已配对 Client,不做多凭据目录。
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { Log } from '@velaros-ai/core'

import type {
  RemoteNodeCredentialStore,
  RemoteNodePairedCredential,
} from './contracts'

const log = Log.tag('RemoteNodeCredentialStore')

/**
 * 落盘形状。
 *
 * 凭据体嵌在 `credential` 下而不是摊平,是为了让 `schemaVersion` 独立演进:将来加字段或换
 * 版本时,读侧仍然是「整体 safeParse 一次」,不需要在两层之间手工搬字段。
 */
const PersistedRemoteNodeCredentialSchema = z.strictObject({
  schemaVersion: z.literal(1),
  credential: z.strictObject({
    clientId: z.string().min(1),
    publicKey: z.string().min(1),
    clientName: z.string().min(1),
    pairedAt: z.number().int().nonnegative(),
  }),
})

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

/**
 * 创建文件凭据存储。
 *
 * 权限模型:目录 `0o700`、文件 `0o600`,写入走 tmp + rename 保证读侧永远看不到半个文件。
 * **注意 Windows**:NTFS 上 POSIX mode 位是惰性的——`0o600` 不会转成任何 ACL,该平台上文件
 * 的实际可见性由继承来的 ACL 决定。把凭据目录锁到当前用户是宿主安装器的职责,不是本层能
 * 兜住的事;本层只保证在 POSIX 侧不留宽权限文件。
 */
export function createRemoteNodeFileCredentialStore(
  path: string,
): RemoteNodeCredentialStore {
  return {
    async load(): Promise<Nullable<RemoteNodePairedCredential>> {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'))
        const parsed = PersistedRemoteNodeCredentialSchema.safeParse(value)
        if (!parsed.success) {
          // 失败即未配对:宁可让人重走一次配对仪式,也不带着来路不明的公钥继续授权。
          log.warn('Remote node credential file is not a valid credential', { path })
          return null
        }
        return parsed.data.credential
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return null
        log.warn('Remote node credential file could not be read', { error, path })
        return null
      }
    },

    async save(credential: RemoteNodePairedCredential): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      // tmp 名带随机后缀:同 pid 下的残留 tmp 会让 `writeFile` 的 mode 失效(mode 只在创建时生效)。
      const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      const payload = { schemaVersion: 1 as const, credential }
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporaryPath, path)
    },

    async clear(): Promise<void> {
      await unlink(path).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    },
  }
}
