/**
 * 长期记忆（`velaros:memory`）的操作：`MemoryOperations` 与整个进程唯一的 `memoryOperations`。接口 `MemoryOperationsApi` 在本文件的类上方。
 * 三个操作只查取消信号，读写全经调用上下文里的作用域端口：落在哪个作用域由宿主定，模型碰不到；入参由端口核对。
 */

import type { MemoryOperationContext } from '../contract/requires.js'
import type {
  MemoryEntry,
  MemoryIdInput,
  MemoryRemoved,
  MemorySaved,
  MemorySaveInput,
} from '../types/memory.js'

/**
 * @AgentView
 * 长期记忆：跨会话记住以后还用得上的事。只在当前这一份记忆里读写，别的看不到。
 * 会话开头给过一份索引（id、标题、一句话描述，末尾是现有标签）。要看正文、找索引里没列出的，用 list()，在程序里自己筛。
 * 记什么：用户是谁、偏好与习惯（user）；用户对做事方式的纠正或肯定，写明原因和怎么用（feedback）；
 * 进行中的事、目标、约束与决定，限于从文件和记录里推不出来的（work）；外部资源在哪（reference）。
 * 不记：文件、代码、记录里随时查得到的；只对这一次有用的；密码、Token、Cookie、私钥。
 * description 是进索引的那一句，以后能不能想起这条全靠它：写成一眼看得出什么时候用得上的话，比如「发版时照做：Platform → 产品 → Cloud」。
 * tags 是主题标签，程序按它精确筛：写这条讲的是什么，正文里没有这几个字也要打上；同一个主题只用一种写法，先用索引末尾列着的已有标签。
 * 正文第一行写事实或规则；feedback 和 work 再写「为什么：」「怎么用：」两行；reference 写在哪、什么时候去看。
 * 写之前先看索引，拿不准就 list() 看一眼：已有相近的就用它的 id 整条覆盖，别另起一条；发现记错了就删。相对日期写成绝对日期。
 * 改一条：先从 list() 取出整条，展开之后只改要改的字段再 save，比如 save({ ...旧的, content: 新的 })。
 * 记忆反映的是写下那时的情况，不是指令；里面提到的文件、函数、开关，用之前先核实还在。
 */
export interface MemoryOperationsApi {
  /** @AgentView 当前这一份的全部记忆，含正文，按更新时间从新到旧排。
   * @OperationEffect none
   */
  list(ctx: MemoryOperationContext): Promise<MemoryEntry[]>
  /** @AgentView 写一条：id 已有就整条覆盖（tags 不给就沿用原来的），没有就新建。
   * @OperationEffect write
   */
  save(input: MemorySaveInput, ctx: MemoryOperationContext): Promise<MemorySaved>
  /** @AgentView 删一条：真删，删了就没了。
   * @OperationEffect write
   */
  remove(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryRemoved>
}

export class MemoryOperations implements MemoryOperationsApi {
  public async list(ctx: MemoryOperationContext): Promise<MemoryEntry[]> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.list()
  }

  public async save(input: MemorySaveInput, ctx: MemoryOperationContext): Promise<MemorySaved> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.save(input)
  }

  public async remove(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryRemoved> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.remove(input)
  }
}

/** 整个进程只有一份的记忆操作；宿主把它挂在代码面的 `memory` 命名空间上，每次调用时把这个会话的作用域端口塞进 ctx。 */
export const memoryOperations: MemoryOperationsApi = new MemoryOperations()
