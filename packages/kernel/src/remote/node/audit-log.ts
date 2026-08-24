// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 追加式审计日志(JSONL)。跨机能力面必须留痕:Node 是别人机器上的一只手,谁在什么时候
// 让它做了什么,必须能离线复核。
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Log } from '@velaros-ai/core'

import type { RemoteNodeAuditEntry, RemoteNodeAuditSink } from './contracts'

const log = Log.tag('RemoteNodeAudit')

/** 按 UTC 日切,不按本地时区:两端时区可以不同,日志的可对齐性比可读性重要。 */
function utcDayStamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10).replaceAll('-', '')
}

export interface RemoteNodeFileAuditLogOptions {
  readonly directory: string
}

/**
 * 创建文件审计日志。
 *
 * 两条纪律:
 *  ① **只写元数据**。`RemoteNodeAuditEntry` 的字段表是封闭的,`input` / `output` 一律不落盘——
 *    跨机链路上流过的可能是 PIN、token 或截图,审计不是证据副本。
 *  ② **绝不把异常抛回调用路径**。写盘经内部串行队列,失败降级为一条告警;审计不可用是运维
 *    事故,但不该连带把正在进行的能力调用打死。串行化同时保证多次 append 不交错(Windows 上
 *    单次 append 并非原子)。
 *
 * 关于文件模式:`0o600` 在 Windows 上是惰性的(NTFS 不由 mode 决定可见性),该平台的 ACL 加固
 * 由宿主安装器负责,见 credential-store 的同款说明。
 */
export function createRemoteNodeFileAuditLog(
  options: RemoteNodeFileAuditLogOptions,
): RemoteNodeAuditSink {
  let writing = Promise.resolve()
  return {
    record(entry: RemoteNodeAuditEntry): void {
      writing = writing
        .then(async () => {
          await mkdir(options.directory, { recursive: true, mode: 0o700 })
          const path = join(options.directory, `audit-${utcDayStamp(entry.at)}.jsonl`)
          await appendFile(path, `${JSON.stringify(entry)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          })
        })
        .catch((error: unknown) => {
          log.warn('Remote node audit line could not be written', {
            error,
            callId: entry.callId,
          })
        })
    },
  }
}
