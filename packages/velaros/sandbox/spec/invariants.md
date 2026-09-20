# 演练沙箱不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

2026-09-18（ADR 0009）：INV-3 原来的「落回的审批是高风险、必须用户亲自点、不可记忆的确认」作废，INV-1、INV-2、INV-5 里跟确认有关的半句随之改写。
落回写的只是模型自己在镜像里做出来的变化，同样的事它用 shell 的 cp、rm 不经确认就能做，这道确认拦不住任何事，只打断模型。镜像里的危险命令照常问（INV-7）。

2026-09-18：`@velaros-ai/system` 整包拆掉，本机演练沙箱（镜像、清单、差量、落回、丢弃）连同实现搬进本单元，值从只给 Node 的 `./local` 入口出，镜像里的命令经 shell 的受约束执行器跑。
承诺随实现搬来、接着编号：INV-9～INV-14 依次是 system 原来的 INV-23、INV-24、INV-25、INV-26、INV-27、INV-28。错误码跟着改名：`SYSTEM_SANDBOX_CONFLICT`、`SYSTEM_SANDBOX_CHANGED` 成了本单元的
`SANDBOX_CONFLICT`、`SANDBOX_CHANGED`（`SandboxErrorCodes`），没有约束后端报 shell 的 `SHELL_CONFINEMENT_UNAVAILABLE`（原来是 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`）。
INV-9 改写了：原来是「cwd 落在镜像根之内的命令一律受约束」，靠本地内核按 cwd 把普通命令改道到沙箱的执行器；这条改道随系统空间的装配一起拆了，
普通 `velaros:shell` 的命令不再看 cwd 在不在镜像里，受约束的只有 `velaros:sandbox` 的 run（宿主端口的 `runInSandbox`），它一律钉在镜像根。
清单读不出来时拒绝执行照旧，只是报的码从约束不可用换成 `NOT_FOUND`（认不出这个沙箱），同样不退回裸进程。
门禁行 INV-4 补了「本机演练沙箱只在 `./local` 入口」一句。
system 原来的 INV-31（系统空间的操作表与模块清单）、INV-35（经系统空间跑一段真程序）随装配表作废：空间由产品自己装，仓库层的 `tests/capabilities/capability-templates.test.ts` 用测试装配接着核对那一份。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 核对过的就是要落的：差量的三列永远完整（不按条数截），落回前按完整三列核对点名的路径，再把同一份差量的指纹交给宿主，镜像在这之后又变过就整批不落 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 点名了没有变化的路径就拒绝（`VALIDATION`），什么都没写；镜像里什么都没变时三列都是空的 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 落回不问用户：审批端口一次都不叫，空间也不再加落回前的授权关（ADR 0009） | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 根入口与 `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载；本机演练沙箱的值只在只给 Node 的 `./local` 入口 | 门禁 | `check:module-ownership` |
| INV-5 | 代码面的 `sandbox` 命名空间是一条真路，不是一道恒空的门：模型写的程序照生成的 `baselines/script/sandbox.d.ts` 过 typecheck，在隔离里把 create → run → diff → apply/discard 整条链跑完，回执形状对得上。作用域由宿主注入的端口解析、不由模型挑（project 的实现把越界的 source 拒掉，system 的实现收任意绝对路径） | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它**整份照生成的真实声明过类型检查**，不嵌进声明，随模型面发布、按需读（`velaros:program` 的 template）。写错的模版会原样教出去，所以不许漂；在真的空间里把每个函数跑一遍、看交回的是不是它说的样子，由仓库层的 `tests/capabilities/capability-templates.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 镜像里的危险命令照常先问用户（ADR 0006）：判定与审批请求用 `velaros:shell` 的那一套，高风险、必须用户亲自点、不可记忆；被拒就抛错，宿主一个进程都不起；不危险的命令不打扰用户 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 差量与输出不折叠：`diff` 的三列永远完整，新增与修改的文本文件都附统一差量（`paths` 只要其中几个），镜像里命令的输出整份交回；只守内存的上限（单文件、单次差量总量、输出各一条），超出的点名没附差量或标 truncated，看多少由程序定 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 本机演练沙箱里的命令一律受进程约束：`velaros:sandbox` 的 run（宿主端口的 `runInSandbox`）钉在镜像根，只能写镜像和沙箱自己的临时目录，写到源目录会失败；没有约束后端的宿主建不出沙箱（`SHELL_CONFINEMENT_UNAVAILABLE`），基目录下不留没有约束的副本；清单读不出来时拒绝执行（`NOT_FOUND`），不退回裸进程 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 落回只写清单记过的文件：源目录里任何一处自建沙箱以来变过就整批不落（`SANDBOX_CONFLICT`，not-applied，冲突列在 message 与 context 里）；任何一层的 `.git`（含嵌套仓库）永远不落 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 丢弃沙箱只删沙箱基目录下面正好一层的目录：id 不合形状、这一项是符号链接、路径解开链接后不在基目录之下或就是基目录本身，一律拒绝；本来就不在的沙箱 removed 为 false，不算错 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 镜像仓库推不出去：镜像里每个仓库（含嵌套仓库、子模块）的每个远端都被改成无效的推送地址，节头写法（CRLF、大小写、尾随空白、旧式 `[remote.x]`）不影响；指向源目录外真实仓库的 `.git` 链接文件不进镜像；网络缺省切断 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 落回只落核对过的那份差量：核对之后镜像又变过就整批不落（`SANDBOX_CHANGED`，not-applied） | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 落回只写在源目录之内、要么全落要么报清落了哪些：上级路径是符号链接或文件（又不在这次删除之列）按冲突整批不落；内容先暂存，拷不全什么都不落；挪到位途中失败在 message 与 context.applied 里点名已落回的路径 | 测试 | `spec/acceptance.test.ts` |
