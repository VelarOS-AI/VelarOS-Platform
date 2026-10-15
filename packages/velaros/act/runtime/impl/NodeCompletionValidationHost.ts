import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isTrue } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { createLocalNodeValidationHost } from '../../../execution/local.js'
import type { NodeValidationFile } from '../../../execution/types/node-validation.js'
import type {
  CompletionValidationHost,
  CompletionValidationRequest,
  NodeCompletionValidationOptions,
} from '../contract/requires.js'
import type { CompletionValidationOutcome } from '../types/completion-validation.js'
import { completionSnapshotMatches } from '../utils/completion-review.js'
import { CompletionReviewLimits } from '../utils/tuning.js'

/** 将当前工作区授权的完整文本副本交给独立验证宿主，不把工作区目录直接暴露给验证代码。 */
export interface NodeCompletionValidationHostApi extends CompletionValidationHost {}

/** Node 宿主将已授权完整文本转交隔离后端；验证代码不能读取原工作区。 */
export class NodeCompletionValidationHost implements NodeCompletionValidationHostApi {
  public constructor(private readonly options: NodeCompletionValidationOptions) {}

  public async execute(
    request: CompletionValidationRequest,
    signal: AbortSignal
  ): Promise<CompletionValidationOutcome> {
    const started = performance.now()
    const current = AbortSignal.any([
      signal,
      ...(this.options.signal ? [this.options.signal] : []),
      AbortSignal.timeout(request.timeoutMs),
    ])
    const files: NodeValidationFile[] = []
    let bytes = 0
    try {
      current.throwIfAborted()
      if (!this.options.artifacts.read || request.fingerprint.status !== 'versioned')
        throw new AppError('UNAVAILABLE', '当前工作区不能提供完整版本绑定的验证文件')
      for (const artifact of request.artifacts) {
        const snapshot = await this.options.artifacts.read(
          artifact.identity,
          request.fingerprint,
          CompletionReviewLimits.sourceBytes,
          current
        )
        if (!completionSnapshotMatches(request.fingerprint, snapshot.fingerprint))
          throw new AppError('STALE', '验证文件读取期间完整快照或授权已变化')
        const material = snapshot.materials.find((entry) => entry.identity === artifact.identity)
        if (!material || material.metadata || !isEmpty(snapshot.issues))
          throw new AppError('UNAVAILABLE', '验证依赖缺少完整 UTF-8 原文')
        const hash = createHash('sha256').update(material.text).digest('hex')
        bytes += Buffer.byteLength(material.text)
        if (hash !== artifact.sha256 || bytes > CompletionReviewLimits.sourceBytes)
          throw new AppError('STALE', '验证文件哈希不一致或输入超过十六 MiB')
        const name = artifact.identity.slice('file:'.length)
        const path = isAbsolute(name) ? relative(resolve(this.options.workspace), name) : name
        const scoped = relative(
          resolve(this.options.workspace),
          resolve(this.options.workspace, path)
        )
        if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`) || isAbsolute(scoped))
          throw new AppError('PERMISSION', '验证文件超出工作区')
        files.push({ identity: artifact.identity, path: scoped, sha256: hash, text: material.text })
      }
      current.throwIfAborted()
      const host = createLocalNodeValidationHost({ executable: this.options.executable })
      return await host.execute(
        {
          files,
          code: request.code,
          timeoutMs: Math.max(1, request.timeoutMs - Math.ceil(performance.now() - started)),
          maxOutputBytes: request.maxOutputBytes,
        },
        current
      )
    } catch (error) {
      return {
        status: 'unavailable',
        timedOut: current.aborted && !signal.aborted && !isTrue(this.options.signal?.aborted),
        cancelled: signal.aborted || isTrue(this.options.signal?.aborted),
        stdout: '',
        stderr: '',
        outputTruncated: false,
        cleanupComplete: true,
        durationMs: performance.now() - started,
        issue: AppError.getMessage(error),
      }
    }
  }
}

/** 为 Desktop 或独立 Node 宿主装配同一版本绑定的验证适配器。 */
export function createNodeCompletionValidationHost(
  options: NodeCompletionValidationOptions
): NodeCompletionValidationHostApi {
  return new NodeCompletionValidationHost(options)
}
