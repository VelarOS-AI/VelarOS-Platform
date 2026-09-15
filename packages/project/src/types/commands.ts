/**
 * 命令判定的数据：执行前对一条 shell 命令的分类结果，以及判定时读出的一次调用。判定本身在 utils/command-policy.ts，
 * 与 system 空间的同名判定逐条一致（仓库层一致性测试守着）。
 */

/** 执行前对一条命令的分类：是否只读、是否危险及原因、是否该转入后台及原因、是否要用户确认，以及命令里可能占用的端口。 */
export interface CommandExecutionPlan {
  /** 整条命令只由只读命令组成，不会改盘、不会执行别的程序。 */
  isReadOnly: boolean
  /** 危险或看起来会长期驻留时为真，执行前要用户确认。 */
  shouldRequestConfirmation: boolean
  /** 看起来会长期驻留（开发服务器、监听进程、末尾裸 &）时为真，应转入后台。 */
  shouldStartInBackground: boolean
  /** 转入后台的原因；不需要时为 null。 */
  reason: Nullable<string>
  /** 会删数据、丢未提交改动、破坏文件系统、提权批量修改，或把下载的脚本直接交给 shell 执行时为真。 */
  isDangerous: boolean
  /** 危险的原因，给用户确认时看；不危险时为 null。 */
  dangerousReason: Nullable<string>
  /** 命令里写到的端口号（--port、-p、:端口），去重。 */
  ports: number[]
}

/** 命令位置上的一次调用：规范化后的命令名与它在本段内的实参。 */
export interface ShellInvocation {
  /** 规范化后的命令名：去掉路径前缀与 .exe，统一小写。 */
  name: string
  /** 命令名之后、本段之内的实参。 */
  args: string[]
}
