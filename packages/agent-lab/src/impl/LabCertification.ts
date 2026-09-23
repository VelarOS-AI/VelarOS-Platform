/**
 * 认证：按一份策略核对一批归档，出一份带自摘要的报告。
 * 判不了的一律记 `unknown`，整份报告因此是 `inconclusive`，不拿缺证据当通过。
 */
import { CertificationReportSchemaId } from '../contract/constants.js'
import type { CertificationCheck, CertificationReport } from '../types/agent-lab.js'
import type { CertificationInput } from '../types/options.js'
import { sha256Json } from '../utils/digests.js'
import {
  attritionCheck,
  baselineCheck,
  certificationStatus,
  coverageChecks,
  integrityChecks,
  journeyChecks,
} from '../utils/measure/certification.js'

/**
 * 第三方执行体与 mod 的认证出口：一份策略、一批归档，出一份可核的报告。
 * 报告自己带 `digest`（内容的 sha256），改一个字摘要就变。实例归本包，进程里只有一份。
 */
export interface LabCertificationApi {
  /** 按策略核对一批归档，出一份认证报告；有 fail 就 `rejected`，有 unknown 就 `inconclusive`。 */
  certify: (input: CertificationInput) => CertificationReport
}

class LabCertification implements LabCertificationApi {
  public certify(input: CertificationInput): CertificationReport {
    const subjectArchives = input.archives.filter(
      (archive) => archive.manifest.executor.executorId === input.subjectExecutorId
    )
    const checks: readonly CertificationCheck[] = [
      ...journeyChecks(input.policy, subjectArchives),
      ...coverageChecks(input.policy, subjectArchives),
      ...integrityChecks(input.policy, subjectArchives),
      attritionCheck(input.policy, subjectArchives),
      baselineCheck(input),
    ]
    const unsigned = {
      schema: CertificationReportSchemaId,
      subject: input.subject,
      policy: input.policy,
      status: certificationStatus(checks),
      checks,
      runIds: subjectArchives.map((archive) => archive.manifest.runId).sort(),
      baselineRunIds: (input.baselineArchives ?? [])
        .map((archive) => archive.manifest.runId)
        .sort(),
      issuedAt: (input.now ?? Date.now)(),
    }
    return { ...unsigned, digest: sha256Json(unsigned) }
  }
}

/** 进程里共用的那一份认证出口。 */
export const labCertification: LabCertificationApi = new LabCertification()
