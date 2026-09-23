/**
 * 报告：把归档折成报告模型，再渲染成自包含的单文件 HTML。
 * 看不到的一律显示未知，报告里不拉任何外部资源。
 */
import type {
  RealTaskAssessment,
  RealTaskRecord,
  ReportRenderOptions,
  RunArchive,
  RunArchiveView,
  RunReportModel,
} from '../types/agent-lab.js'
import { createRunReportModel } from '../utils/measure/report-model.js'
import { renderHistoricalReportHtml } from '../utils/render/historical-report.js'
import { renderRealTaskReportHtml } from '../utils/render/real-task-report.js'
import { renderReportHtml } from '../utils/render/run-report.js'

/**
 * 三种报告的出口：运行报告、历史归档报告、真实任务报告。
 * 三份 HTML 都自包含——不联网、不拉字体图片、不发请求；渲染完当场核对，不合格就抛错而不是写一份坏报告出去。
 * 实例归本包，进程里只有一份。
 */
export interface LabReportsApi {
  /** 把一份归档折成报告模型：完成度、判词、数据缺口与每一段。 */
  createRunReportModel: (archive: RunArchive) => RunReportModel
  /** 把一批运行报告模型渲染成一份自包含 HTML。 */
  renderRunReportHtml: (models: readonly RunReportModel[], options?: ReportRenderOptions) => string
  /** 把一批历史归档视图渲染成一份自包含 HTML；缺的字段显示破折号。 */
  renderHistoricalReportHtml: (
    views: readonly RunArchiveView[],
    options?: ReportRenderOptions
  ) => string
  /** 渲染一份真实任务报告；它永远不嵌入提示词、回答、绝对路径或产物正文。 */
  renderRealTaskReportHtml: (record: RealTaskRecord, assessment: RealTaskAssessment) => string
}

class LabReports implements LabReportsApi {
  public createRunReportModel(archive: RunArchive): RunReportModel {
    return createRunReportModel(archive)
  }

  public renderRunReportHtml(
    models: readonly RunReportModel[],
    options: ReportRenderOptions = {}
  ): string {
    return renderReportHtml(models, options)
  }

  public renderHistoricalReportHtml(
    views: readonly RunArchiveView[],
    options: ReportRenderOptions = {}
  ): string {
    return renderHistoricalReportHtml(views, options)
  }

  public renderRealTaskReportHtml(record: RealTaskRecord, assessment: RealTaskAssessment): string {
    return renderRealTaskReportHtml(record, assessment)
  }
}

/** 进程里共用的那一份报告出口。 */
export const labReports: LabReportsApi = new LabReports()
