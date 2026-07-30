// 域：会话控制面的**窄门面**（send / steer / wake / answer / approve / cancel / runtimeStatus）。
//
// ## 跨层接缝与方向铁律
// 本门面是「外部意图 → 会话运行时」的唯一入口形状，实现全部由宿主经 `KernelSessionControllerAdapter`
// 注入。**方向单向**：门面调适配器，适配器绝不反向持有门面。
//
// **防复辟提示**：`wake` / `answer` / `approve` / `runtimeStatus` 看上去是「零价值转发」，别按 §3.2
// 顺手删——它们是**架构面**：这层的价值在于把控制面收敛成一组闭集动词，让宿主实现可替换（Desktop /
// headless / serve 各注一份），并让审批载荷经 `TApproval` 类型参数在派发点消除强转。删了转发就等于把
// 每个调用点直接绑到某个具体宿主服务上。
//
// ## 两处**不是**纯转发、改动前先看清楚的地方
//  - `send` = admit + wake **两步**：先拿到 seq 落账，再用该 seq 唤醒。顺序反过来（先 wake 后 admit）
//    会让唤醒跑在输入入账之前，那一轮什么都读不到，表现为「发了消息但 AI 没反应」。
//  - `cancel` 把适配器可能返回的 void 归一成 `{ aborted: false }`——缺席回落到「没中止成功」
//    是安全方向（§0.1 之三），反过来谎报中止成功会让上层错误地清理运行态。
//
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
