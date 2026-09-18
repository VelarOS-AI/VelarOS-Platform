# shell 能力不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。INV-1、INV-2 从 `@velaros-ai/system` 的 INV-2、INV-3 移来（命令判定整体搬进本包）；system 原来的 INV-18（只读白名单必须严格）就是 INV-1 的「误判方向只允许非只读」，不再单列。
INV-5～INV-9 是 `velar:shell` 搬进本包时立的：INV-6、INV-7、INV-9 分别接过 system 原来的 INV-32、INV-4、INV-15。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 只读判定是白名单加整体否决：白名单命令一旦带写盘或执行别的程序的参数（sed 脚本整段解析，认不出就算写）、前缀带环境变量赋值或 env -S / time -o、重定向、子 shell 或未知的 git 形态，整条判非只读；误判方向只允许"非只读" | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 递归删除整个目录一律判危险并要求确认，理由写明删的是整个文件夹；删单个文件是日常操作，不打扰用户 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 危险命令的审批请求是高风险、必须用户亲自点、不可按类记忆的确认；操作身份只由去掉首尾空白的命令、工作目录、前台还是后台决定，跨入口一致 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 根入口与 `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-5 | 代码面的 `shell` 命名空间是一条真路：模型写的程序照生成的 `baselines/code-surface/shell.d.ts` 过 typecheck，在隔离里经 `shellOperations` 调到空间注入的 `ShellSpacePort`。工作目录由端口解析、不由模型挑（项目那样的端口把越界的 cwd 拒在确认与执行之前，系统那样的收任意目录）；长驻命令自动转后台，后台任务按会话登记、按会话查 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 上限归这件能力自己钳，不靠调用方拦：`run` 的 timeoutMs 超了按上限跑（钳而不拒）。输出**不折叠**：stdout、stderr 与后台任务的输出都整份交给程序，列后台任务不设条数，看多少由程序定；只守内存的上限（`ShellLimits.outputChars`，超出只留末尾并标 truncated）。声明里写的数字与上限表一致 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 危险命令每次都要用户亲自确认（高风险、手动、不可记忆），确认文案与风险分类用空间给的口径；被拒时一个进程都不起，拒绝原样抛给程序；要了交互式却没拿到控制台时回执直说用户输入不了 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它**整份照生成的真实声明过类型检查**，不嵌进声明，随模型面发布、按需读（`velar:program` 的 template）；在真的空间里把每个函数跑一遍、看交回的是不是它说的样子，由仓库层的 `tests/capabilities/capability-templates.test.ts` 核对（两个空间各一遍） | 测试 | `spec/acceptance.test.ts` |
| INV-9 | `nativeCommand` 只供宿主组合能力使用，**永不进模型可观测面**：`ShellRunCommandOptions` 不带 `@AgentView`，生成的 `shell.d.ts` 里没有它；模型面上也没有空间端口与调用上下文的影子 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 模型的回执只留它用得上的：命令、目录、成败、退出码与信号、超时与取消、耗时、全部输出；进了后台的只给 taskId、端口、是否自动转的与控制台。进程号、终止命令、进程约束与归属、捕获的账、验证摘要是宿主与界面用的，不进模型面。后台任务用 `stop` 停（按会话核对归属，缺省普通终止、force 强杀），不必自己拼终止命令 | 测试 | `spec/acceptance.test.ts` |
