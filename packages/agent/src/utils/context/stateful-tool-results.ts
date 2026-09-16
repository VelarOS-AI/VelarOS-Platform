/**
 * 这个工具的结果要不要按「有状态」长期保留——恒为假：不再靠工具名硬编码猜测保留策略。
 * 能力包要让自己的状态持久留在上下文里，应当走 context collector 显式贡献，而不是指望这一层认名字。
 * 保留形参与这个判定点，是为了调用方不必因为策略改变而改结构。
 */
function isStatefulToolResultName(_toolName: string): boolean {
  return false
}

export { isStatefulToolResultName }
