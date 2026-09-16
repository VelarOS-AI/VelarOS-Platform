/**
 * 命令行的六条命令。它只把参数折成对上面几件能力的调用，自己不做实现，也不碰 `process`：
 * 输出与退出码以数据返回，真正写出去是包根 `bin/` 那个可执行壳的事。
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AgentLabCliResult, RunArchiveView } from '../types/agent-lab.js'
import type { LoadedArchives, ParsedArguments } from '../types/internal.js'
import type { AgentLabCliOptions, CertificationInput } from '../types/options.js'
import { readJsonFile } from '../utils/archive-files.js'
import { numberFlag, optionalFlag, parseArguments, requiredFlag } from '../utils/arguments.js'

import { journeyRunner } from './JourneyRunner.js'
import { labArchives } from './LabArchives.js'
import { labCertification } from './LabCertification.js'
import { labReports } from './LabReports.js'
import { labStatistics } from './LabStatistics.js'
import { labWire } from './LabWire.js'
import { realTaskWorkload } from './RealTaskWorkload.js'

/**
 * `velaros-agent-lab` 这一件能力：校验、审计、跑 job、出报告、比较、认证。
 * `run` 要的套件运行时由调用方从 `AgentLabRuntimeLoader` 注入——本包不做动态 import。
 * 跑完给回退出码与两个流的文字，写出去与设置 `process.exitCode` 都在可执行壳里。实例归本包，进程里只有一份。
 */
export interface AgentLabCliApi {
  /** 跑一条命令；参数不对、文件读不出来、校验不过都折成 stderr 与非零退出码，不往外抛。 */
  run: (argv: readonly string[], options: AgentLabCliOptions) => Promise<AgentLabCliResult>
}

class AgentLabCli implements AgentLabCliApi {
  /** 帮助文字：命令、参数名与路径占位一律原样，不翻译。 */
  private static readonly Help = [
    'VelarOS Agent Lab',
    '',
    '命令：',
    '  validate <journey|job|run|real-task|case> <文件>    校验一份线格式数据',
    '  audit-record <record.json> --output <目录>          审计一条真实任务记录，写出三件套',
    '  run --job <job.json> --runtime <runtime.mjs>        跑一个 job 的全部试验',
    '  report <文件或目录...> --output <report.html>       出一份自包含 HTML 报告',
    '  compare <文件或目录...> --a <执行体> --b <执行体>   两个执行体的成对比较',
    '                        [--minimum-effect N] [--seed N]',
    '  certify <文件或目录...> --policy <policy.json>      按策略认证一个对象',
    '                        --subject <subject.json> --executor <id>',
    '                        [--baseline <路径>] [--baseline-executor <id>]',
    '',
  ].join('\n')

  /** 退出码：0 正常，1 判定失败或出错，2 判不了（不可比、认证 inconclusive）。 */
  private static readonly ExitCodes = { ok: 0, failed: 1, inconclusive: 2 } as const

  /** `validate` 认的五种数据。 */
  private static readonly ValidationKinds = ['journey', 'job', 'run', 'real-task', 'case'] as const

  private readonly wire = labWire

  private readonly archives = labArchives

  private readonly reports = labReports

  private readonly statistics = labStatistics

  private readonly certification = labCertification

  private readonly workload = realTaskWorkload

  private readonly runner = journeyRunner

  public async run(argv: readonly string[], options: AgentLabCliOptions): Promise<AgentLabCliResult> {
    const parsed = parseArguments(argv)
    const command = parsed.command
    if (!command || command === 'help' || command === '--help' || command === '-h' || parsed.flags.help) return { exitCode: AgentLabCli.ExitCodes.ok, stdout: AgentLabCli.Help, stderr: '' }
    try {
      if (command === 'validate') return await this.validate(parsed)
      if (command === 'audit-record') return await this.auditRecord(parsed)
      if (command === 'run') return await this.runJob(parsed, options)
      if (command === 'report') return await this.report(parsed, options)
      if (command === 'compare') return await this.compare(parsed)
      if (command === 'certify') return await this.certify(parsed)
      throw new Error(`不认识这条命令: ${command}`)
    } catch (error) {
      return {
        exitCode: AgentLabCli.ExitCodes.failed,
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      }
    }
  }

  /** 把一批文件或目录读成归档：文件直接读，目录走归档发现；有读不出来的目录当场报错。 */
  private async loadArchives(paths: readonly string[]): Promise<LoadedArchives> {
    const views: RunArchiveView[] = []
    for (const path of paths) {
      const absolute = resolve(path)
      const details = await stat(absolute)
      if (details.isFile()) views.push(this.archives.readRunArchiveView(await readJsonFile(absolute)))
      else if (details.isDirectory()) {
        const discovery = await this.archives.discoverRunArchives(absolute)
        views.push(...discovery.archives.map((entry) => entry.view))
        if (discovery.unreadableDirectories.length > 0) {
          throw new Error(`这些运行目录里的归档读不出来: ${discovery.unreadableDirectories.join(', ')}`)
        }
      }
    }
    return { archives: views.flatMap((view) => (view.archive ? [view.archive] : [])), views }
  }

  /** `validate`：按种类严格校验一份线格式数据。 */
  private async validate(parsed: ParsedArguments): Promise<AgentLabCliResult> {
    const [kind, path] = parsed.positionals
    if (!kind || !path) {
      throw new Error(`用法: velaros-agent-lab validate <${AgentLabCli.ValidationKinds.join('|')}> <文件>`)
    }
    const value = await readJsonFile(path)
    if (kind === 'journey') this.wire.parseJourney(value)
    else if (kind === 'job') this.wire.parseJob(value)
    else if (kind === 'run') this.wire.parseRunArchive(value)
    else if (kind === 'real-task') this.wire.parseRealTaskRecord(value)
    else if (kind === 'case') this.wire.parseRealTaskCase(value)
    else throw new Error(`不认识这种校验对象: ${kind}`)
    return { exitCode: AgentLabCli.ExitCodes.ok, stdout: `valid ${kind}: ${resolve(path)}\n`, stderr: '' }
  }

  /** `audit-record`：审计一条真实任务记录，写出记录、评估与 HTML 三件套。 */
  private async auditRecord(parsed: ParsedArguments): Promise<AgentLabCliResult> {
    const [path] = parsed.positionals
    if (!path) throw new Error('用法: velaros-agent-lab audit-record <record.json> --output <目录>')
    const record = await this.archives.readRealTaskRecord(path)
    const assessment = this.workload.audit(record)
    const written = await this.archives.writeRealTaskBundle(requiredFlag(parsed, 'output'), record, assessment)
    const payload = { verdict: assessment.verdict, findings: assessment.findings.length, ...written }
    return {
      exitCode: assessment.verdict === 'verified-fail' ? AgentLabCli.ExitCodes.failed : AgentLabCli.ExitCodes.ok,
      stdout: `${JSON.stringify(payload, null, 2)}\n`,
      stderr: '',
    }
  }

  /** `run`：加载套件运行时，跑完一个 job 的全部试验，每出一份归档就写盘。 */
  private async runJob(parsed: ParsedArguments, options: AgentLabCliOptions): Promise<AgentLabCliResult> {
    const job = this.wire.parseJob(await readJsonFile(requiredFlag(parsed, 'job')))
    const runtime = await options.loadRuntime.load(requiredFlag(parsed, 'runtime'))
    const archives = await this.runner.runJob(job, {
      resolveDriver: (trial) => runtime.resolveDriver(trial),
      runTrial: async (trial, driver) =>
        this.runner.runJourney({
          jobId: job.id,
          suiteId: job.suiteId,
          trial,
          journey: await runtime.getJourney(trial),
          driver,
          detectors: runtime.detectors,
          verifiers: runtime.verifiers,
          workspaceRoot: runtime.workspaceRoot,
          sourceCommit: runtime.sourceCommit,
          consumerCommit: runtime.consumerCommit,
        }),
      onArchive: async (archive) => {
        await this.archives.writeRunArchive(job.archiveDirectory, archive)
      },
    })
    const payload = { runs: archives.length, archiveDirectory: resolve(job.archiveDirectory) }
    return { exitCode: AgentLabCli.ExitCodes.ok, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' }
  }

  /** `report`：全是 v3 归档就出运行报告，混了历史归档就出历史归档报告。 */
  private async report(parsed: ParsedArguments, options: AgentLabCliOptions): Promise<AgentLabCliResult> {
    if (parsed.positionals.length === 0) throw new Error('report 至少要给一个文件或目录')
    const output = resolve(requiredFlag(parsed, 'output'))
    const loaded = await this.loadArchives(parsed.positionals)
    if (loaded.views.length === 0) throw new Error('没有找到任何 JSON 归档')
    const generatedAt = (options.now ?? Date.now)()
    const models = loaded.archives.map((archive) => this.reports.createRunReportModel(archive))
    const html =
      loaded.archives.length === loaded.views.length
        ? this.reports.renderRunReportHtml(models, { generatedAt })
        : this.reports.renderHistoricalReportHtml(loaded.views, { generatedAt })
    await this.archives.writeReportFile(output, html)
    return { exitCode: AgentLabCli.ExitCodes.ok, stdout: `${output}\n`, stderr: '' }
  }

  /** `compare`：两个执行体的成对比较；不可比时退出码 2。 */
  private async compare(parsed: ParsedArguments): Promise<AgentLabCliResult> {
    const executorA = requiredFlag(parsed, 'a')
    const executorB = requiredFlag(parsed, 'b')
    const loaded = await this.loadArchives(parsed.positionals)
    const result = this.statistics.compareExecutors(loaded.archives, executorA, executorB, {
      minimumEffect: numberFlag(parsed, 'minimum-effect', 0),
      seed: numberFlag(parsed, 'seed', 1),
    })
    return {
      exitCode: result.decision === 'not-comparable' ? AgentLabCli.ExitCodes.inconclusive : AgentLabCli.ExitCodes.ok,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: '',
    }
  }

  /** `certify`：按策略认证一个对象；被拒退出码 1，判不了退出码 2。 */
  private async certify(parsed: ParsedArguments): Promise<AgentLabCliResult> {
    const policy = this.wire.parseCertificationPolicy(await readJsonFile(requiredFlag(parsed, 'policy')))
    const subject = this.wire.parseCertificationSubject(await readJsonFile(requiredFlag(parsed, 'subject')))
    const loaded = await this.loadArchives(parsed.positionals)
    const baselinePath = optionalFlag(parsed, 'baseline')
    const baseline = baselinePath === null ? { archives: [] } : await this.loadArchives([baselinePath])
    const baselineExecutorId = optionalFlag(parsed, 'baseline-executor')
    const base = {
      policy,
      subject,
      archives: loaded.archives,
      baselineArchives: baseline.archives,
      subjectExecutorId: requiredFlag(parsed, 'executor'),
    }
    const input: CertificationInput = baselineExecutorId === null ? base : { ...base, baselineExecutorId }
    const result = this.certification.certify(input)
    const exitCode =
      result.status === 'rejected'
        ? AgentLabCli.ExitCodes.failed
        : result.status === 'inconclusive'
          ? AgentLabCli.ExitCodes.inconclusive
          : AgentLabCli.ExitCodes.ok
    return { exitCode, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' }
  }
}

/** 进程里共用的那一份命令行能力。 */
export const agentLabCli: AgentLabCliApi = new AgentLabCli()
