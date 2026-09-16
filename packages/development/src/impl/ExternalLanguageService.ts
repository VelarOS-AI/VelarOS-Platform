import { extname } from 'node:path'

import { isEmpty, Log, toNullable } from '@velaros-ai/core'

import { BuiltinExternalLanguageServers } from '../contract/constants.js'
import type {
  ExternalLanguageDiagnostic,
  ExternalLanguageHover,
  ExternalLanguageLocation,
  ExternalLanguageServerSpec,
  ExternalLanguageStatus,
} from '../types/development.js'
import { errorMessage } from '../utils/lsp.js'
import { resolveProjectRealPath } from '../utils/project-paths.js'
import { DevelopmentTuning } from '../utils/tuning.js'

import {
  ExternalLanguageServerClient,
  type ExternalLanguageServerClientApi,
} from './ExternalLanguageServerClient.js'

const log = Log.tag('ExternalLanguageService')

/**
 * 一个项目上的外部语言服务集合：按扩展名挑规格、按需拉起进程、把诊断与跳转归一成本包的形状。
 *
 * 实例由 `createExternalLanguageService` 按项目根各造一份。只启动规格表里给的命令，
 * 只解析项目根以内的文件（按真实路径判定，符号链接指到外面一样拒）；启动失败的规格记进
 * 不可用表，同一份实例里不再重试。
 */
export interface ExternalLanguageServiceApi {
  /** 这个路径的扩展名有没有登记过的语言服务规格。 */
  supports(path: string): boolean
  /** 这批语言服务的整体状态，含最近一次 `diagnostics()` 完不完整。 */
  status(): ExternalLanguageStatus
  /**
   * 收集这批文件的诊断。
   *
   * 「等到超时也没收到」与「真的一条问题都没有」在返回值里长得一样，所以超时的文件数记进
   * `status()`（`diagnosticsComplete` / `diagnosticsTimedOutFiles`）并留一条警告日志：
   * 调用方据此判断这次的空结果能不能当成「没问题」。
   */
  diagnostics(
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageDiagnostic[]>
  /** 问一个位置的悬停说明；没有可用的语言服务时抛错。 */
  hover(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLanguageHover>>
  /** 问一个位置的定义；没有可用的语言服务时抛错。 */
  definition(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]>
  /** 问一个位置的引用；没有可用的语言服务时抛错。 */
  references(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]>
  /** 关掉本实例拉起的全部语言服务进程。 */
  stop(): Promise<void>
}

/** 一个项目上的外部语言服务集合，见接口说明。 */
class ExternalLanguageService implements ExternalLanguageServiceApi {
  private readonly clients = new Map<string, ExternalLanguageServerClientApi>()
  private readonly unavailable = new Map<string, string>()
  /** 最近一次 diagnostics() 里等到超时的文件数：结果是否完整全看它。 */
  private diagnosticsTimedOutFiles = 0

  public constructor(
    private readonly projectRoot: string,
    private readonly specs: readonly ExternalLanguageServerSpec[]
  ) {}

  public supports(path: string): boolean {
    const extension = extname(path).toLowerCase()
    return this.specs.some((spec) => spec.extensions.includes(extension))
  }

  public status(): ExternalLanguageStatus {
    const clients = [...this.clients.values()]
    const errors = [...this.unavailable.values()]
    const ready = clients.some((client) => client.status().state === 'ready')
    return {
      state: ready ? 'ready' : !isEmpty(errors) ? 'unavailable' : 'idle',
      server: clients.map((client) => client.spec.id).join(', ') || 'external',
      openFiles: clients.reduce((total, client) => total + client.status().openFiles, 0),
      error: ready ? null : toNullable(errors.at(-1)),
      diagnosticsTimedOutFiles: this.diagnosticsTimedOutFiles,
      diagnosticsComplete: this.diagnosticsTimedOutFiles === 0,
    }
  }

  public async diagnostics(
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageDiagnostic[]> {
    const files = await this.resolveFiles(paths)
    const results: ExternalLanguageDiagnostic[] = []
    const timedOutFiles: string[] = []
    for (const file of files) {
      const client = await this.clientFor(file, signal)
      if (!client) continue
      const outcome = await client.diagnostics(file, signal)
      results.push(...outcome.diagnostics)
      if (outcome.timedOut) timedOutFiles.push(file)
    }
    this.diagnosticsTimedOutFiles = timedOutFiles.length
    if (!isEmpty(timedOutFiles)) {
      log.warn('语言服务在超时前没有发回这些文件的诊断，这次的空结果不代表它们没有问题。', {
        files: timedOutFiles.slice(0, DevelopmentTuning.externalLanguageServer.reportedTimedOutFiles),
        timedOutFiles: timedOutFiles.length,
      })
    }
    return results
  }

  public async hover(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLanguageHover>> {
    const file = await resolveProjectRealPath(this.projectRoot, path)
    const client = await this.requireClient(file, signal)
    return client.hover(file, line, column, signal)
  }

  public async definition(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]> {
    const file = await resolveProjectRealPath(this.projectRoot, path)
    const client = await this.requireClient(file, signal)
    return client.locations('textDocument/definition', file, line, column, signal)
  }

  public async references(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]> {
    const file = await resolveProjectRealPath(this.projectRoot, path)
    const client = await this.requireClient(file, signal)
    return client.locations('textDocument/references', file, line, column, signal)
  }

  public async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()))
    this.clients.clear()
  }

  /** 取这个文件的语言服务；一个都起不来就抛，说清是没登记规格还是本机没装。 */
  private async requireClient(
    file: string,
    signal?: AbortSignal
  ): Promise<ExternalLanguageServerClientApi> {
    const client = await this.clientFor(file, signal)
    if (client) return client
    const extension = extname(file).toLowerCase()
    if (!this.supports(file))
      throw new Error(`没有为 ${extension || '这种文件类型'} 登记语言服务适配器。`)
    throw new Error(`本机没有装可用于 ${extension} 的语言服务。`)
  }

  /** 按扩展名挑规格，逐个尝试拉起；启动失败的规格记进不可用表，本实例内不再重试。 */
  private async clientFor(
    file: string,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLanguageServerClientApi>> {
    const extension = extname(file).toLowerCase()
    const candidates = this.specs.filter((spec) => spec.extensions.includes(extension))
    for (const spec of candidates) {
      const existing = this.clients.get(spec.id)
      if (existing) return existing
      if (this.unavailable.has(spec.id)) continue
      const client = new ExternalLanguageServerClient(this.projectRoot, spec)
      try {
        await client.start(signal)
        this.clients.set(spec.id, client)
        return client
      } catch (error) {
        let failure = `${spec.id}：${errorMessage(error)}`
        log.debug('语言服务启动失败，准备清理子进程。', { error, server: spec.id })
        try {
          await client.stop()
        } catch (stopError) {
          failure = `${failure}；清理时又失败：${errorMessage(stopError)}`
          log.debug('语言服务启动失败后的清理也未完成。', { error: stopError, server: spec.id })
        }
        this.unavailable.set(spec.id, failure)
      }
    }
    return null
  }

  /** 把调用方给的路径解析成项目内的真实路径，并只留有语言服务认得的那些。 */
  private async resolveFiles(paths: readonly string[]): Promise<string[]> {
    const files: string[] = []
    for (const path of paths) {
      const file = await resolveProjectRealPath(this.projectRoot, path)
      if (this.supports(file)) files.push(file)
    }
    return [...new Set(files)]
  }
}

/**
 * 造一份项目上的外部语言服务集合；不给 `specs` 就用内置的九个规格。
 *
 * 进程按需拉起：只有真的查到某个扩展名的文件时才会 spawn。用完记得 `stop()`。
 */
export function createExternalLanguageService(
  projectRoot: string,
  specs: readonly ExternalLanguageServerSpec[] = BuiltinExternalLanguageServers
): ExternalLanguageServiceApi {
  return new ExternalLanguageService(projectRoot, specs)
}
