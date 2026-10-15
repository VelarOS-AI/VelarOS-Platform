import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isTrue } from '@velaros-ai/core'
import { isEmpty, isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { LocalNodeValidationOptions } from '../../contract/requires.js'
import type { NodeValidationRequest, NodeValidationResult } from '../../types/node-validation.js'
import type { ShellCommandResult } from '../../types/shell-command.js'
import {
  nodeValidationOutput,
  nodeValidationPreflight,
  nodeValidationProfile,
} from '../../utils/node-validation.js'
import { NodeValidationLimits } from '../../utils/tuning.js'

import type { LocalShellHostApi } from './LocalShellHost.js'
import { createLocalShellHost } from './LocalShellHost.js'

/** 仅接受宿主已核对的文件副本；每次运行拥有独立目录、预检和进程监督。 */
export interface NodeValidationHostApi {
  /** 不支持所需隔离能力时返回 unavailable；取消后完成资源回收再交回结果。 */
  execute(request: NodeValidationRequest, signal: AbortSignal): Promise<NodeValidationResult>
}

/** macOS 默认拒绝验证后端；不把其他系统或缺少能力的宿主降级成普通命令执行。 */
export class NodeValidationHost implements NodeValidationHostApi {
  public constructor(private readonly options: LocalNodeValidationOptions) {}

  public async execute(
    request: NodeValidationRequest,
    signal: AbortSignal
  ): Promise<NodeValidationResult> {
    const started = performance.now()
    let root: string | undefined
    let shell: LocalShellHostApi | undefined
    let execution: ShellCommandResult | undefined
    let environmentSha256: string | undefined
    let issue: string | undefined
    let cleanupComplete = true
    let output = { stdout: '', stderr: '', truncated: false }
    const deadline = AbortSignal.timeout(
      Number.isSafeInteger(request.timeoutMs)
        ? Math.min(NodeValidationLimits.timeoutMs, Math.max(1, request.timeoutMs))
        : 1
    )
    const current = AbortSignal.any([signal, deadline])
    try {
      current.throwIfAborted()
      if (process.platform !== 'darwin')
        throw new AppError('UNAVAILABLE', '当前宿主没有经过验证的独立 Node 隔离后端')
      if (
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        request.timeoutMs > NodeValidationLimits.timeoutMs ||
        !Number.isSafeInteger(request.maxOutputBytes) ||
        request.maxOutputBytes < 1 ||
        request.maxOutputBytes > NodeValidationLimits.outputBytes ||
        isEmpty(request.files) ||
        request.files.length > NodeValidationLimits.files ||
        Buffer.byteLength(request.code) > NodeValidationLimits.codeBytes ||
        !request.code.trim()
      )
        throw new AppError('VALIDATION', '独立验证输入超过宿主固定额度')
      const runtime = await realpath(this.options.executable)
      if (!(await lstat(runtime)).isFile())
        throw new AppError('UNAVAILABLE', '验证运行时必须是普通文件')
      const loader = await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb')
      const runtimeHash = createHash('sha256')
      for await (const chunk of createReadStream(runtime)) {
        current.throwIfAborted()
        runtimeHash.update(chunk)
      }
      root = await realpath(await mkdtemp(join(tmpdir(), 'velar-validation-')))
      const input = join(root, 'input')
      const working = join(root, 'work')
      await mkdir(input)
      await mkdir(join(working, 'tmp'), { recursive: true })
      const paths = new Set<string>()
      const identities = new Set<string>()
      const mappings: Record<string, string> = {}
      let bytes = 0
      for (const file of request.files) {
        current.throwIfAborted()
        const path = resolve(input, file.path)
        if (
          !file.path ||
          file.path.includes('\\') ||
          !path.startsWith(input + sep) ||
          paths.has(path) ||
          identities.has(file.identity)
        )
          throw new AppError('PERMISSION', '验证副本的文件路径或身份无效')
        const content = Buffer.from(file.text)
        bytes += content.length
        if (
          bytes > NodeValidationLimits.inputBytes ||
          createHash('sha256').update(content).digest('hex') !== file.sha256
        )
          throw new AppError('STALE', '验证输入超过额度或完整字节哈希不匹配')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, { flag: 'wx', mode: 0o400 })
        paths.add(path)
        identities.add(file.identity)
        mappings[file.identity] = pathToFileURL(path).href
      }
      const sentinel = join(root, 'outside-sentinel')
      const inputSentinel = join(input, '.host-validation-probe')
      await writeFile(sentinel, 'owned sentinel', { flag: 'wx', mode: 0o600 })
      await writeFile(inputSentinel, 'read-only sentinel', { flag: 'wx', mode: 0o400 })
      await chmod(input, 0o500)
      const profile = nodeValidationProfile(runtime, input, working)
      const environment = Object.fromEntries(
        Object.keys(process.env).map((key) => [key, undefined])
      )
      Object.assign(environment, {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        TMPDIR: join(working, 'tmp'),
        TMP: join(working, 'tmp'),
        TEMP: join(working, 'tmp'),
        VELAR_REVIEW_INPUTS: JSON.stringify(mappings),
      })
      shell = createLocalShellHost({ cwd: working })
      const run = async (entry: string, timeoutMs: number) =>
        shell!.runCommand(
          'Independent Node validation',
          {
            nativeCommand: {
              file: '/usr/bin/sandbox-exec',
              args: ['-p', profile, '--', runtime, entry],
            },
            environment,
            timeoutMs,
            maxOutputChars: request.maxOutputBytes,
          },
          false,
          current
        )
      const preflight = join(working, 'preflight.mjs')
      await writeFile(preflight, nodeValidationPreflight(sentinel, inputSentinel), {
        flag: 'wx',
        mode: 0o600,
      })
      const probe = await run(
        preflight,
        Math.min(request.timeoutMs, NodeValidationLimits.preflightMs)
      )
      if (!probe.success || probe.truncated || probe.cleanupIncomplete)
        throw new AppError('UNAVAILABLE', `隔离能力预检未通过：${probe.stderr.slice(0, 1000)}`)
      const preflightResult = JSON.parse(probe.stdout.trim()) as {
        node?: string
        boundaries?: boolean
      }
      if (!isTrue(preflightResult.boundaries) || !preflightResult.node)
        throw new AppError('UNAVAILABLE', '隔离能力预检没有完整回执')
      environmentSha256 = createHash('sha256')
        .update(
          JSON.stringify({
            nodeSha256: runtimeHash.digest('hex'),
            node: preflightResult.node,
            platform: process.platform,
            release: release(),
            arch: process.arch,
            loaderSha256: createHash('sha256').update(loader).digest('hex'),
            profileSha256: createHash('sha256').update(profile).digest('hex'),
          })
        )
        .digest('hex')
      const entry = join(working, 'validate.mjs')
      await writeFile(entry, request.code, { flag: 'wx', mode: 0o600 })
      current.throwIfAborted()
      execution = await run(entry, request.timeoutMs)
      output = nodeValidationOutput(execution.stdout, execution.stderr, request.maxOutputBytes)
      for (const file of request.files) {
        const copied = await readFile(resolve(input, file.path))
        if (createHash('sha256').update(copied).digest('hex') !== file.sha256)
          throw new AppError('STALE', '执行期间只读副本发生变化')
      }
      if ((await readFile(sentinel, 'utf8')) !== 'owned sentinel')
        throw new AppError('PERMISSION', '执行越过了临时工作目录边界')
    } catch (error) {
      Log.tag('NodeValidation').debug('独立验证执行未通过', error)
      issue = AppError.getMessage(error)
    } finally {
      try {
        await shell?.dispose()
      } catch (error) {
        Log.tag('NodeValidation').debug('验证进程清理失败', error)
        cleanupComplete = false
        issue = `验证进程清理失败：${AppError.getMessage(error)}`
      }
      if (execution?.cleanupIncomplete) cleanupComplete = false
      if (root && cleanupComplete) {
        try {
          await chmod(join(root, 'input'), 0o700).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
          await rm(root, { recursive: true, force: true })
        } catch (error) {
          Log.tag('NodeValidation').debug('验证目录清理失败', error)
          cleanupComplete = false
          issue = `验证目录清理失败：${AppError.getMessage(error)}`
        }
      }
    }
    const timedOut = deadline.aborted || isTrue(execution?.timedOut)
    const cancelled = signal.aborted || (isTrue(execution?.aborted) && !timedOut)
    const outputTruncated = output.truncated || isTrue(execution?.truncated)
    let result: NodeValidationResult = {
      status: !execution
        ? 'unavailable'
        : execution.success &&
            !issue &&
            !timedOut &&
            !cancelled &&
            !outputTruncated &&
            cleanupComplete
          ? 'passed'
          : 'failed',
      timedOut,
      cancelled,
      stdout: output.stdout,
      stderr: output.stderr,
      outputTruncated,
      cleanupComplete,
      durationMs: performance.now() - started,
    }
    if (isPresent(execution?.exitCode)) result = { ...result, exitCode: execution.exitCode }
    if (execution?.signal) result = { ...result, signal: execution.signal }
    if (issue) result = { ...result, issue }
    if (environmentSha256) result = { ...result, environmentSha256 }
    return result
  }
}

/** 创建具有独立临时目录和每次能力预检的本机验证入口。 */
export function createLocalNodeValidationHost(
  options: LocalNodeValidationOptions
): NodeValidationHostApi {
  return new NodeValidationHost(options)
}
