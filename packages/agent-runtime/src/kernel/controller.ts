import type { KernelRuntimeStatus } from './policy'
import type { KernelInputDelivery } from './session-lane'

export interface KernelControllerTarget {
  sessionId: string
  seq?: number
}

export interface KernelControllerSendInput {
  id: string
  sessionId: string
  role?: 'user' | 'system' | 'assistant' | 'tool'
  content: string
  delivery?: KernelInputDelivery
  metadata?: Record<string, unknown>
}

export interface KernelInputReceipt {
  inputId: string
  sessionId: string
  seq: number
}

export interface KernelCancelResult {
  aborted: boolean
}

export interface KernelControllerAnswerInput extends KernelControllerTarget {
  answer: string
}

// 审批载荷对内核控制器是不透明的：默认 unknown，宿主适配器（如 Desktop 的 confirmation
// 卡片结果 UserActionCardResult[]）用类型参数声明其正式类型，消除派发点的强转。
export interface KernelControllerApprovalInput<TApproval = unknown> extends KernelControllerTarget {
  approved: boolean
  rejectionMessage?: LooseOptional<string>
  approvalPayload?: LooseOptional<TApproval>
}

export interface KernelSessionControllerAdapter<TApproval = unknown> {
  admit(input: KernelControllerSendInput): Promise<KernelInputReceipt>
  wake(target: KernelControllerTarget): Promise<void>
  steer(input: KernelControllerSendInput): Promise<void>
  answer(input: KernelControllerAnswerInput): Promise<void>
  approve(input: KernelControllerApprovalInput<TApproval>): Promise<void>
  runtimeStatus(target: KernelControllerTarget): Promise<KernelRuntimeStatus>
  cancel(target: KernelControllerTarget): Promise<KernelCancelResult | void>
}

export class KernelSessionController<TApproval = unknown> {
  constructor(private readonly adapter: KernelSessionControllerAdapter<TApproval>) {}

  public async send(input: KernelControllerSendInput): Promise<KernelInputReceipt> {
    const receipt = await this.adapter.admit(input)
    await this.adapter.wake({ sessionId: input.sessionId, seq: receipt.seq })
    return receipt
  }

  public async steer(input: KernelControllerSendInput): Promise<KernelInputReceipt> {
    const receipt = await this.adapter.admit({
      ...input,
      delivery: 'steer',
    })
    await this.adapter.steer({
      ...input,
      delivery: 'steer',
    })
    return receipt
  }

  public async wake(target: KernelControllerTarget): Promise<void> {
    await this.adapter.wake(target)
  }

  public async answer(input: KernelControllerAnswerInput): Promise<void> {
    await this.adapter.answer(input)
  }

  public async approve(input: KernelControllerApprovalInput<TApproval>): Promise<void> {
    await this.adapter.approve(input)
  }

  public async runtimeStatus(target: KernelControllerTarget): Promise<KernelRuntimeStatus> {
    return this.adapter.runtimeStatus(target)
  }

  public async cancel(target: KernelControllerTarget): Promise<KernelCancelResult> {
    return (await this.adapter.cancel(target)) ?? { aborted: false }
  }
}
