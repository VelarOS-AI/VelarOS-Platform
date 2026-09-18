/**
 * 注入面：宿主必须或可以塞进来的东西。
 * 本包不认宿主，只认这三个口子：一次语言查询的上下文、它借的只读内核端口，以及可选的代码图谱后端。
 */
import type { AgentProjectKernelPort, ProjectOperationContext } from '@velaros-ai/velar/project'
import type { ProjectCodeIndexQuery } from '@velaros-ai/velar/project/contracts'

/**
 * 语言查询借的只读内核端口：列文件、读正文、列符号，三件事而已。
 *
 * 写成这个别名是要写死「语言查询不消耗项目的修改、执行与审批能力」——宿主给的内核就算带着写入口，
 * 本包也够不着。谁给：宿主在 `LanguageToolContext.project.kernel()` 里给；每次查询都要。
 */
export type LanguageReadPort = Pick<AgentProjectKernelPort, 'listFiles' | 'read' | 'listSymbols'>

/**
 * 一次语言查询的上下文。谁给：宿主（Desktop / Workbench / Termel）在每次查询时给；必须。
 *
 * 路径一律相对项目根，没有「按目录执行」这回事：语言查询不改变任何进程状态。
 */
export interface LanguageToolContext {
  /** 中止信号；本包在每次列目录、读文件与逐文件诊断之间检查它。 */
  abortSignal: AbortSignal
  /** 项目面：项目根与只读内核。 */
  project: {
    /** 项目根的绝对路径。 */
    getRootPath(): string
    /** 取只读内核端口；每次查询取一次，宿主可以在这里做懒装配。 */
    kernel(): Promise<LanguageReadPort>
  }
}

/**
 * 宿主的代码图谱后端。谁给：宿主在 `createProjectCodeQuery` 建查询时给；可选——
 * 给一个永远不可用的空实现也合法（Termel 就是），此时代码图谱类动作抛 `UNAVAILABLE`，
 * 内置的七个语言动作照常可用。
 */
export interface ProjectCodeIndexApi {
  /** 图谱后端现在能不能用；为假时本包不调 `query`，直接抛 `UNAVAILABLE`。 */
  isAvailable(): boolean
  /** 执行一次代码图谱查询；返回值原样交给调用方，本包只给它加上 `source` 字段。 */
  query(input: ProjectCodeIndexQuery, context: ProjectOperationContext): Promise<unknown>
}
