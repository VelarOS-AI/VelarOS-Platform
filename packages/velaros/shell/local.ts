/**
 * shell 的本机实现入口（`@velaros-ai/velaros/shell/local`），只给 Node 宿主：本机宿主（跑命令、后台任务、交互式控制台、shell 选择、
 * 进程约束，外加宿主界面要的进程、端口、资源快照与环境体检）与受约束执行器（演练沙箱的镜像根各用一个），以及由应用持有、工作区借用的登录环境。
 * 空间怎么装是宿主自己的事：系统空间把本机宿主接成 `ShellSpacePort` 的执行那一半，自己补作用域与口径。
 * 它们的接口、配置与用到的数据从根入口取。
 */

export { createConfinedShellRunner } from './impl/local/ConfinedShellRunner.js'
export { createLocalShellHost } from './impl/local/LocalShellHost.js'
export { createShellEnvironment } from './impl/local/ShellEnvironment.js'
