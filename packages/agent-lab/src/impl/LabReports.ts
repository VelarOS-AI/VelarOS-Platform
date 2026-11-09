/**
 * 报告：把归档折成报告模型，再渲染成自包含的单文件 HTML。
 * 看不到的一律显示未知，报告里不拉任何外部资源。
 */
import type {
  RealTaskAssessment,
  ReportRenderOptions,
  RunArchive,
  RunReportModel,
} from '../types/agent-lab.js'
import { createRunReportModel } from '../utils/measure/report-model.js'
import { renderRealTaskReportHtml } from '../utils/render/real-task-report.js'
import { renderReportHtml } from '../utils/render/run-report.js'
import { realTaskAssessmentSchema } from '../utils/wire/workload.js'

/**
 * 当前运行报告与真实任务报告的出口。
 * HTML 由固定模板与转义文本构成，不联网、不拉字体图片、不发请求；未知保留，非法数值拒绝渲染。
 * 实例归本包，进程里只有一份。
 */
export interface LabReportsApi {
  /** 把一份归档折成报告模型：完成度、判词、数据缺口与每一段。 */
  createRunReportModel: (archive: RunArchive) => RunReportModel
  /** 把一批运行报告模型渲染成一份自包含 HTML。 */
  renderRunReportHtml: (models: readonly RunReportModel[], options?: ReportRenderOptions) => string
  /** 校验当前评估并渲染闭集状态、数值和分类计数；自由文本及身份只留在私有 JSON。 */
  renderRealTaskReportHtml: (assessment: RealTaskAssessment) => string
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

  public renderRealTaskReportHtml(assessment: RealTaskAssessment): string {
    return renderRealTaskReportHtml(realTaskAssessmentSchema.parse(assessment))
  }
}

/** 进程里共用的那一份报告出口。 */
export const labReports: LabReportsApi = new LabReports()
