/** 判定内部的工作类型：命令位置上的一次调用。只放类型，不出包。 */

/** 命令位置上的一次调用：规范化后的命令名与它在本段内的实参。 */
export interface ShellInvocation {
  name: string
  args: string[]
}
