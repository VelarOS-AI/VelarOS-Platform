/**
 * 当前 v3 归档与真实任务的记录、用例落盘；读写都严格校验，不改写原件。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type {
  DiscoveredRunArchive,
  RealTaskAssessment,
  RealTaskCase,
  RealTaskRecord,
  RunArchive,
  RunArchiveDiscovery,
} from '../types/agent-lab.js'
import {
  readRunArchiveDirectory,
  runArchivePath,
  writeJsonAtomically,
  writeTextAtomically,
} from '../utils/archive-files.js'
import { renderRealTaskReportHtml } from '../utils/render/real-task-report.js'
import { runArchiveSchema } from '../utils/wire/journey.js'
import {
  realTaskAssessmentSchema,
  realTaskCaseSchema,
  realTaskRecordSchema,
} from '../utils/wire/workload.js'

/**
 * 归档的读写口。写一律是原子的（先写同目录临时文件再改名），写之前一律先严格校验；
 * 读取只接受当前格式，不补字段、不回写。实例归本包，进程里只有一份。
 */
export interface LabArchivesApi {
  /** 校验并原子写一份 v3 归档到 `<root>/<runId>/report.json`，返回写到哪；run id 不能当目录名时当场报错。 */
  writeRunArchive: (root: string, archive: RunArchive) => Promise<string>
  /** 读取并严格校验一份当前 v3 归档；错误保留原件并向调用方报告。 */
  readRunArchive: (path: string) => Promise<RunArchive>
  /** 在目录下查找当前 `report.json`；缺席才跳过，坏格式或 I/O 失败直接报错。 */
  discoverRunArchives: (root: string) => Promise<RunArchiveDiscovery>
  /** 写一份真实任务的三件套（记录、评估、HTML 报告）；评估不属于这条记录时当场报错。 */
  writeRealTaskBundle: (
    directory: string,
    record: RealTaskRecord,
    assessment: RealTaskAssessment
  ) => Promise<{ readonly record: string; readonly assessment: string; readonly report: string }>
  /** 读一条真实任务记录，读出来先校验。 */
  readRealTaskRecord: (path: string) => Promise<RealTaskRecord>
  /** 原子写一条复跑用例，返回写到哪。 */
  writeRealTaskCase: (path: string, input: RealTaskCase) => Promise<string>
  /** 读一条复跑用例，读出来先校验。 */
  readRealTaskCase: (path: string) => Promise<RealTaskCase>
  /** 原子写一份已经渲染好的报告文件（HTML），返回写到哪。 */
  writeReportFile: (path: string, html: string) => Promise<string>
}

class LabArchives implements LabArchivesApi {
  /** 一个运行目录里的三个固定文件名。 */
  private static readonly BundleFiles = {
    record: 'record.json',
    assessment: 'assessment.json',
    report: 'report.html',
  } as const

  public async writeRunArchive(root: string, archive: RunArchive): Promise<string> {
    const parsed = runArchiveSchema.parse(archive)
    const target = runArchivePath(root, parsed.manifest.runId)
    await writeJsonAtomically(target, parsed)
    return target
  }

  public async readRunArchive(path: string): Promise<RunArchive> {
    return runArchiveSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }

  public async discoverRunArchives(root: string): Promise<RunArchiveDiscovery> {
    const absolute = resolve(root)
    const details = await stat(absolute)
    if (!details.isDirectory()) throw new Error(`归档根不是一个目录: ${absolute}`)

    const direct = await readRunArchiveDirectory(absolute)
    if (direct) return { archives: [direct], skippedDirectories: 0 }

    const entries = await readdir(absolute, { withFileTypes: true })
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(absolute, entry.name))
      .sort((left, right) => basename(left).localeCompare(basename(right)))
    const archives: DiscoveredRunArchive[] = []
    let skippedDirectories = 0
    for (const directory of directories) {
      const archive = await readRunArchiveDirectory(directory)
      if (archive) archives.push(archive)
      else skippedDirectories += 1
    }
    return { archives, skippedDirectories }
  }

  public async writeRealTaskBundle(
    directory: string,
    recordInput: RealTaskRecord,
    assessmentInput: RealTaskAssessment
  ): Promise<{ readonly record: string; readonly assessment: string; readonly report: string }> {
    const record = realTaskRecordSchema.parse(recordInput)
    const assessment = realTaskAssessmentSchema.parse(assessmentInput)
    if (assessment.recordId !== record.id) throw new Error('这份评估不属于给定的真实任务记录')
    const root = resolve(directory)
    const recordPath = join(root, LabArchives.BundleFiles.record)
    const assessmentPath = join(root, LabArchives.BundleFiles.assessment)
    const reportPath = join(root, LabArchives.BundleFiles.report)
    await writeJsonAtomically(recordPath, record)
    await writeJsonAtomically(assessmentPath, assessment)
    await writeTextAtomically(reportPath, renderRealTaskReportHtml(record, assessment))
    return { record: recordPath, assessment: assessmentPath, report: reportPath }
  }

  public async readRealTaskRecord(path: string): Promise<RealTaskRecord> {
    return realTaskRecordSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')))
  }

  public async writeRealTaskCase(path: string, input: RealTaskCase): Promise<string> {
    const target = resolve(path)
    await writeJsonAtomically(target, realTaskCaseSchema.parse(input))
    return target
  }

  public async readRealTaskCase(path: string): Promise<RealTaskCase> {
    return realTaskCaseSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')))
  }

  public async writeReportFile(path: string, html: string): Promise<string> {
    const target = resolve(path)
    await writeTextAtomically(target, html)
    return target
  }
}

/** 进程里共用的那一份归档读写口。 */
export const labArchives: LabArchivesApi = new LabArchives()
