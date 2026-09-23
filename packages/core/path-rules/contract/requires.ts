/**
 * 注入面：问 git 的执行口。本包自己不起子进程——起不起、怎么起、超时多久是各空间自己的事，
 * 它们把执行口塞进来；拿不到 git 时本包按本地 .gitignore 规则兜底。这里的每个类型都必须从根入口导出。
 */

/**
 * 批量问 git 哪些相对路径被忽略（`git check-ignore --no-index --stdin -z`，在 rootPath 里跑）：
 * 返回被忽略的那些相对路径（用 `/` 分隔、不带末尾斜杠）；git 不在、跑不起来、退出码不是 0 或 1 时返回 null，
 * 本包据此回退到本地规则，并且这一轮之后不再问 git。
 */
export type GitCheckIgnoreRunner = (
  rootPath: string,
  relativePaths: readonly string[]
) => Promise<Nullable<ReadonlySet<string>>>
