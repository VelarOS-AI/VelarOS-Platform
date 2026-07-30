/**
 * ws_read 重复回读账本。
 *
 * 观察到的失败模式(ask1 实机 + 直接问模型并核对真实历史后确认):模型创建/编辑完文件后，对
 * **同一个文件的同一个版本**反复回读(读了头再读尾、又读更小的尾、又读中间),把"回读确认完整性"
 * 当必要步骤。关键是——它给出的回读理由(如"文件被外部修改过"、"输出被截断 truncated:true")经
 * 核对 debug rawRequest(模型真正收到的历史)**根本不存在于工具返回里**,是模型自己编造的(文件
 * 内容含 module.exports 在其历史里出现 29 次、truncated 字段 0 次)。所以靠提示词/信任结果都压
 * 不住,得机制上拦。
 *
 * 账本按 **codingSession 对象身份**(每个 run/会话唯一,WeakMap 自动回收、无需穿透 sessionId)+
 * `path@revision` 记录**已经喂给模型的行区间**。同一版本(内容没变)再来读:
 * - 请求区间已被之前喂过的区间完全覆盖 → 判定为纯重复回读,不再重发全文,返回一句硬提示;
 * - 请求了**新的、尚未读过的区间**(比如先读头、现在要读尾)→ 照常放行并记账(不误伤正当分段浏览)。
 * 文件一旦被编辑(revision 变化),`path@revision` 键变化 → 新版本首读照常放行。
 */

interface LineInterval {
  start: number
  /** 开区间末端用 Number.POSITIVE_INFINITY 表示"读到文件末尾/整文件"。 */
  end: number
}

export interface WorkspaceReadLedgerDecision {
  /** true=这次读的区间此前已全部喂过(纯重复回读),应拦下。 */
  redundant: boolean
  /** 该 path@revision 此前已放行过的读取次数(用于提示措辞)。 */
  priorReads: number
}

interface PathReadState {
  revision: string
  intervals: LineInterval[]
  priorReads: number
}

/** 每个 run 的 codingSession 对象 → (path -> 当前版本已读区间)。WeakMap:会话结束自动回收。 */
const ledgersByCodingSession = new WeakMap<object, Map<string, PathReadState>>()

function ledgerForSession(sessionKey: object): Map<string, PathReadState> {
  const existing = ledgersByCodingSession.get(sessionKey)
  if (existing) return existing
  const created = new Map<string, PathReadState>()
  ledgersByCodingSession.set(sessionKey, created)
  return created
}

/** 仅供测试:传入的 sessionKey 用完即弃,无需清理;此函数保留占位以便未来扩展。 */
export function resetWorkspaceReadLedgerForTests(): void {
  // WeakMap 无法枚举清空；测试用新的 sessionKey 对象即可天然隔离。
}

function normalizeRequestedInterval(range?: {
  startLine?: number
  endLine?: number
}): LineInterval {
  const start = range?.startLine && range.startLine > 0 ? Math.floor(range.startLine) : 1
  const end =
    range?.endLine && range.endLine > 0 ? Math.floor(range.endLine) : Number.POSITIVE_INFINITY
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/**
 * target 是否被已读区间完全覆盖。intervals 始终保持合并/不相交(每次 add 都 mergeInterval),
 * 所以"被并集覆盖"等价于"被某一段合并区间包含"——直接找是否存在 iv 包住 target 即可
 * (这样也避免 Infinity>Infinity 这类边界坑,整文件 [1,∞) 覆盖 [1,∞) 正确判 true)。
 */
function isFullyCovered(target: LineInterval, intervals: LineInterval[]): boolean {
  return intervals.some((iv) => iv.start <= target.start && iv.end >= target.end)
}

function mergeInterval(intervals: LineInterval[], next: LineInterval): LineInterval[] {
  const all = [...intervals, next].sort((a, b) => a.start - b.start)
  const merged: LineInterval[] = []
  for (const iv of all) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end + 1) {
      last.end = Math.max(last.end, iv.end)
    } else {
      merged.push({ ...iv })
    }
  }
  return merged
}

/**
 * 记录并判定一次 ws_read。redundant=true 时调用方应改为返回硬提示、不重发全文。
 * sessionKey 传该 run 的 codingSession 对象;revision 用于区分版本——编辑后版本变化,首读照常放行。
 */
export function checkAndRecordWorkspaceRead(
  sessionKey: object,
  path: string,
  revision: string,
  range?: { startLine?: number; endLine?: number }
): WorkspaceReadLedgerDecision {
  const ledger = ledgerForSession(sessionKey)
  const requested = normalizeRequestedInterval(range)
  const existing = ledger.get(path)

  // 新文件、或版本已变(被编辑过)→ 重置该 path 的已读区间,首读放行。
  if (!existing || existing.revision !== revision) {
    ledger.set(path, { revision, intervals: [requested], priorReads: 1 })
    return { redundant: false, priorReads: 0 }
  }

  const priorReads = existing.priorReads
  if (isFullyCovered(requested, existing.intervals)) {
    // 同版本、且这段内容此前已喂过 → 纯重复回读。
    existing.priorReads = priorReads + 1
    return { redundant: true, priorReads }
  }

  // 同版本但请求了新区间(如先读头现在读尾)→ 放行并并入已读集。
  existing.intervals = mergeInterval(existing.intervals, requested)
  existing.priorReads = priorReads + 1
  return { redundant: false, priorReads }
}

/** 合成"别再重复回读"的硬提示文案。 */
export function buildRedundantWorkspaceReadNotice(
  path: string,
  revision: string,
  priorReads: number
): string {
  return [
    `你本会话已经读过 ${path} 的当前版本(revision ${revision})共 ${priorReads} 次，这段内容之前已经完整给过你、且文件自那以后没有任何改动。`,
    `重复回读同一个没变的文件不会返回任何新信息，只是浪费轮次——请直接使用你已有的内容继续。`,
    `如果你确实还有某一段没读过（比如只读了开头、还没看结尾），可以只读那一段新范围；但不要再重复读已经读过的部分。`,
  ].join('\n')
}
