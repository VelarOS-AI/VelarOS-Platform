/**
 * 自适应战役：下一批跑什么由账本决定——没修完的失败挡住新采样，修完之后先跑证明任务。
 */
import type { CampaignRootCauseClass } from '../contract/constants.js'
import type {
  AdaptiveCampaignInput,
  AdaptiveCampaignSelection,
  CampaignFailureRecord,
  RealTaskCase,
  RecordCampaignFailureInput,
  TransitionCampaignFailureInput,
} from '../types/agent-lab.js'
import {
  realTaskSemanticSignature,
  reconcileCampaignProof,
  recordCampaignFailure,
  recordCampaignProof,
  requiredProofCount,
  selectAdaptiveCampaignTasks,
  transitionCampaignFailure,
} from '../utils/measure/campaign.js'

/**
 * 战役账本这一件能力：选下一批、记失败、推状态机、记证明、按当前通过集校准缓存的证明。
 * 账本是证明的权威，笔记本只是缓存；用例改了或运行时换了底，缓存的证明要能被撤销。
 * 实例归本包，进程里只有一份。
 */
export interface AdaptiveCampaignApi {
  /** 一条用例的语义签名：换个说法的同一件事拿不到额外的覆盖信用。 */
  semanticSignature: (task: RealTaskCase) => string
  /** 选出最小有用的下一批；有 open / diagnosed 的失败时一条都不选，先修。 */
  selectTasks: (input: AdaptiveCampaignInput) => AdaptiveCampaignSelection
  /** 一条修完的失败要几个证明任务通过才关。 */
  requiredProofCount: (classification: CampaignRootCauseClass) => number
  /** 记一次失败：同一把钥匙的账合成一条，重新打开时已有的证明作废。 */
  recordFailure: (input: RecordCampaignFailureInput) => readonly CampaignFailureRecord[]
  /** 让一条失败账换状态；状态机不许的流转、缺根因或缺修复引用的一律当场报错。 */
  transitionFailure: (input: TransitionCampaignFailureInput) => CampaignFailureRecord
  /** 记一个证明任务通过；数够了就关账。 */
  recordProof: (failure: CampaignFailureRecord, taskId: string) => CampaignFailureRecord
  /** 按当前真正通过的任务集校准缓存的证明；证明可以被撤销，但不假装那次修复没发生过。 */
  reconcileProof: (
    failure: CampaignFailureRecord,
    currentPassingTaskIds: ReadonlySet<string>
  ) => CampaignFailureRecord
}

class AdaptiveCampaign implements AdaptiveCampaignApi {
  public semanticSignature(task: RealTaskCase): string {
    return realTaskSemanticSignature(task)
  }

  public selectTasks(input: AdaptiveCampaignInput): AdaptiveCampaignSelection {
    return selectAdaptiveCampaignTasks(input)
  }

  public requiredProofCount(classification: CampaignRootCauseClass): number {
    return requiredProofCount(classification)
  }

  public recordFailure(input: RecordCampaignFailureInput): readonly CampaignFailureRecord[] {
    return recordCampaignFailure(input)
  }

  public transitionFailure(input: TransitionCampaignFailureInput): CampaignFailureRecord {
    return transitionCampaignFailure(input)
  }

  public recordProof(failure: CampaignFailureRecord, taskId: string): CampaignFailureRecord {
    return recordCampaignProof(failure, taskId)
  }

  public reconcileProof(
    failure: CampaignFailureRecord,
    currentPassingTaskIds: ReadonlySet<string>
  ): CampaignFailureRecord {
    return reconcileCampaignProof(failure, currentPassingTaskIds)
  }
}

/** 进程里共用的那一份战役账本。 */
export const adaptiveCampaign: AdaptiveCampaignApi = new AdaptiveCampaign()
