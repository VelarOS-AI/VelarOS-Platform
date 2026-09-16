// 域：会话控制面的**窄门面**（send / steer / wake / answer / approve / cancel / runtimeStatus）。
//
// ## 跨层接缝与方向铁律
// 本门面是「外部意图 → 会话运行时」的唯一入口形状，实现全部由宿主经 `KernelSessionControllerAdapter`
// 注入。**方向单向**：门面调适配器，适配器绝不反向持有门面。
//
// **防复辟提示**：`wake` / `answer` / `approve` / `runtimeStatus` 看上去是「零价值转发」，别按 §3.2
// 顺手删——它们是**架构面**：这层的价值在于把控制面收敛成一组闭集动词，让桌面、headless 和
// serve 等宿主注入各自实现，并让审批载荷经 `TApproval` 类型参数在派发点消除强转。删了转发就等于把
// 每个调用点直接绑到某个具体宿主服务上。
//
// ## 两处**不是**纯转发、改动前先看清楚的地方
//  - `send` = admit + wake **两步**：先拿到 seq 落账，再用该 seq 唤醒。顺序反过来（先 wake 后 admit）
//    会让唤醒跑在输入入账之前，那一轮什么都读不到，表现为「发了消息但 AI 没反应」。
//  - `cancel` 把适配器可能返回的 void 归一成 `{ aborted: false }`——缺席回落到「没中止成功」
//    是安全方向（§0.1 之三），反过来谎报中止成功会让上层错误地清理运行态。
//
import type { KernelCancelResult, KernelControllerAnswerInput, KernelControllerApprovalInput, KernelControllerSendInput, KernelControllerTarget, KernelInputReceipt, KernelRuntimeStatus } from '../../types/execution.js'

/**
 * 宿主为这组控制面动词提供的实现。由持有门面的那一方（桥）在建门面时一次性交进来，
 * 之后只被门面调用；适配器绝不反向持有门面。每个方法都按「失败就抛」约定，门面不吞异常。
 */
export interface KernelSessionControllerAdapter<TApproval = unknown> {
  /** 把一条输入写进账本并拿回回执（含单调 seq）。同一条输入重复 admit 应当幂等地给回同一个 seq。 */
  admit(input: KernelControllerSendInput): Promise<KernelInputReceipt>
  /** 唤醒这个会话的消费循环，从 `target.seq` 起把账本里已获准的输入跑掉。必须在 admit 之后调用。 */
  wake(target: KernelControllerTarget): Promise<void>
  /** 把一条已按 `steer` 入账的输入提到排队消息前面，让它在当前这一轮就生效。 */
  steer(input: KernelControllerSendInput): Promise<void>
  /** 把用户对某个在途追问的回答交给运行时，解开那一轮的等待。 */
  answer(input: KernelControllerAnswerInput): Promise<void>
  /** 把用户对某个在途确认的批准/拒绝交给运行时；`approvalPayload` 由 `TApproval` 定形，门面不解释它。 */
  approve(input: KernelControllerApprovalInput<TApproval>): Promise<void>
  /** 归约并返回这个会话此刻的运行态（在不在跑、有没有待确认、排队条数、后台任务数等）。 */
  runtimeStatus(target: KernelControllerTarget): Promise<KernelRuntimeStatus>
  /** 中断这个会话；返回中止结论，宿主也可以什么都不返回，门面会当作「没中止成功」。 */
  cancel(target: KernelControllerTarget): Promise<KernelCancelResult | void>
}

/**
 * 会话控制面的窄门面：把「外部意图 → 会话运行时」收敛成一组闭集动词，实现全部经
 * {@link KernelSessionControllerAdapter} 注入。门面自己不存状态，只负责调用顺序与缺省归一。
 * 每座桥建一个，和桥同生命周期。
 */
export interface KernelSessionControllerApi<TApproval = unknown> {
  /** 发一条消息：先 admit 落账拿到 seq，再用该 seq 唤醒。顺序反了会让唤醒跑在入账之前，那一轮读不到东西。 */
  send(input: KernelControllerSendInput): Promise<KernelInputReceipt>
  /** 插一条话：以 `steer` 投递方式入账，再让适配器把它提到排队消息前面；返回入账回执。 */
  steer(input: KernelControllerSendInput): Promise<KernelInputReceipt>
  /** 单独唤醒一个会话的消费循环，不带新输入。用于账本已有内容但没人驱动的场合。 */
  wake(target: KernelControllerTarget): Promise<void>
  /** 转投一条对在途追问的回答。 */
  answer(input: KernelControllerAnswerInput): Promise<void>
  /** 转投一次对在途确认的批准或拒绝。 */
  approve(input: KernelControllerApprovalInput<TApproval>): Promise<void>
  /** 取一份会话运行态快照，原样来自适配器。 */
  runtimeStatus(target: KernelControllerTarget): Promise<KernelRuntimeStatus>
  /** 中断一个会话；适配器没给结论时归一成 `{ aborted: false }`——缺席回落到「没中止成功」是安全方向。 */
  cancel(target: KernelControllerTarget): Promise<KernelCancelResult>
}

export class KernelSessionController<TApproval = unknown>
  implements KernelSessionControllerApi<TApproval> {
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
