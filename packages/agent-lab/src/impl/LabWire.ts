/**
 * 线格式的唯一出口：每一种外部数据进来之前先严格校验，未声明的字段一律拒收。
 * zod schema 不出包，外面只拿得到这里的几个 `parse*`。
 */
import type {
  CertificationPolicy,
  CertificationSubject,
  JobSpec,
  JourneySpec,
  RealTaskAcceptanceContract,
  RealTaskAssessment,
  RealTaskCase,
  RealTaskRecord,
  RunArchive,
} from '../types/agent-lab.js'
import { certificationPolicySchema, certificationSubjectSchema } from '../utils/wire/certification.js'
import { jobSpecSchema, journeySpecSchema, runArchiveSchema } from '../utils/wire/journey.js'
import {
  realTaskAcceptanceContractSchema,
  realTaskAssessmentSchema,
  realTaskCaseSchema,
  realTaskRecordSchema,
} from '../utils/wire/workload.js'

/**
 * 本包认的每一种线格式的校验入口。校验一律是严格的：多出来的字段就是拒收，
 * 加字段要先升 schema 版本，不靠「对端忽略未知字段」兜底。失败时抛错（zod 的错误，带路径与错误码）。
 * 实例归本包，进程里只有一份。
 */
export interface LabWireApi {
  /** 校验一条旅程定义：段 id 与判据 id 不许重复，段数预算不能小过声明的段数。 */
  parseJourney: (value: unknown) => JourneySpec
  /** 校验一个 job：至少一次试验，并发度按常量表的上限卡。 */
  parseJob: (value: unknown) => JobSpec
  /** 校验一份运行归档（v3）。 */
  parseRunArchive: (value: unknown) => RunArchive
  /** 校验一条真实任务记录。 */
  parseRealTaskRecord: (value: unknown) => RealTaskRecord
  /** 校验一份真实任务评估。 */
  parseRealTaskAssessment: (value: unknown) => RealTaskAssessment
  /** 校验一条真实任务复跑用例。 */
  parseRealTaskCase: (value: unknown) => RealTaskCase
  /** 校验一条验收合同：宿主自己攒验收条件时用它，不用把 schema 拿出去。 */
  parseAcceptanceContract: (value: unknown) => RealTaskAcceptanceContract
  /** 校验一份认证策略。 */
  parseCertificationPolicy: (value: unknown) => CertificationPolicy
  /** 校验一个认证对象。 */
  parseCertificationSubject: (value: unknown) => CertificationSubject
}

class LabWire implements LabWireApi {
  public parseJourney(value: unknown): JourneySpec {
    return journeySpecSchema.parse(value)
  }

  public parseJob(value: unknown): JobSpec {
    return jobSpecSchema.parse(value)
  }

  public parseRunArchive(value: unknown): RunArchive {
    return runArchiveSchema.parse(value)
  }

  public parseRealTaskRecord(value: unknown): RealTaskRecord {
    return realTaskRecordSchema.parse(value)
  }

  public parseRealTaskAssessment(value: unknown): RealTaskAssessment {
    return realTaskAssessmentSchema.parse(value)
  }

  public parseRealTaskCase(value: unknown): RealTaskCase {
    return realTaskCaseSchema.parse(value)
  }

  public parseAcceptanceContract(value: unknown): RealTaskAcceptanceContract {
    return realTaskAcceptanceContractSchema.parse(value)
  }

  public parseCertificationPolicy(value: unknown): CertificationPolicy {
    return certificationPolicySchema.parse(value)
  }

  public parseCertificationSubject(value: unknown): CertificationSubject {
    return certificationSubjectSchema.parse(value)
  }
}

/** 进程里共用的那一份线格式校验入口。 */
export const labWire: LabWireApi = new LabWire()
