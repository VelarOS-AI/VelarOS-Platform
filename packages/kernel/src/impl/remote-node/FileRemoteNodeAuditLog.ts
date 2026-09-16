// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 追加式审计日志(JSONL)。跨机能力面必须留痕:Node 是别人机器上的一只手,谁在什么时候
// 让它做了什么,必须能离线复核。
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Log } from '@velaros-ai/core'

import { KernelFileModes } from '../../contract/constants'
import type { RemoteNodeAuditSink } from '../../contract/requires'
import type { RemoteNodeFileAuditLogOptions } from '../../types/remote'
import type { RemoteNodeAuditEntry } from '../../types/remote-node'
const log = Log.tag('RemoteNodeAudit')

/**
 * 文件审计落点。
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
export class FileRemoteNodeAuditLog implements RemoteNodeAuditSink {
  /** 写盘串行队列:一条接一条,既防交错也把失败挡在调用路径之外。 */
  private writing = Promise.resolve()

  public constructor(private readonly options: RemoteNodeFileAuditLogOptions) {}

  public record(entry: RemoteNodeAuditEntry): void {
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.options.directory, {
          recursive: true,
          mode: KernelFileModes.privateDirectory,
        })
        await appendFile(this.filePathFor(entry.at), `${JSON.stringify(entry)}\n`, {
          encoding: 'utf8',
          mode: KernelFileModes.privateFile,
        })
      })
      .catch((error: unknown) => {
        log.warn('Remote node audit line could not be written', {
          error,
          callId: entry.callId,
        })
      })
  }

  /** 按 UTC 日切分文件,不按本地时区:两端时区可以不同,日志的可对齐性比可读性重要。 */
  private filePathFor(at: number): string {
    const stamp = new Date(at).toISOString().slice(0, 10).replaceAll('-', '')
    return join(this.options.directory, `audit-${stamp}.jsonl`)
  }
}

/** 建一个文件审计落点;`directory` 不存在时首次写入按 0700 自建。 */
export function createRemoteNodeAuditLog(
  options: RemoteNodeFileAuditLogOptions,
): RemoteNodeAuditSink {
  return new FileRemoteNodeAuditLog(options)
}

/** `createRemoteNodeAuditLog` 的现有导出名,保住消费方这一轮零改动。 */
export function createRemoteNodeFileAuditLog(
  options: RemoteNodeFileAuditLogOptions,
): RemoteNodeAuditSink {
  return new FileRemoteNodeAuditLog(options)
}
