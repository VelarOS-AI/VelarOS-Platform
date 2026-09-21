# Script 执行引擎不变量

编号保持稳定。源码版本、控制调用恢复与结果租约由 Velaros 验收覆盖；本表登记引擎的检查、编辑、隔离和结果契约。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 先检查后执行：程序是 JavaScript，但**照样过 TypeScript 的检查**（`checkJs`，类型从生成的声明推）；没过时程序**一行都不执行**，回的是诊断而不是结果；诊断的行号与模型写的那一行对得上，中间不转译所以行号不会错位 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 程序够不到宿主的环境能力：读写文件、起子进程在隔离里一律失败，程序只能经能力端口做事 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 到时必停：超过 `timeoutMs` 的程序一定被终止并回 `TIMEOUT`，死循环也不例外；`signal` 触发时同样停 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 拒绝是可捕获的异常：能力端口报错在程序里是一个能 `try/catch` 的 throw，不是一份静默的空回执；**拒绝**（用户或策略说了不，码里带 DENIED、PERMISSION）同时进回给模型的 `notices`，程序把异常吞了模型也知道；找不到、不唯一这类是调用自己的结果，程序接得住，不在 `notices` 里再回放；程序正是死在那次拒绝上时 `failed` 已经说了，不重复 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 隔离运行器使用 QuickJS WASM 与显式能力桥；发布认证标记 `NodeSubprocessRunnerIsReleaseReady` 保持 false，由宿主完成部署隔离验收 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 大字符串走 `blobs` 不进源码：含反引号、`${`、反斜杠、引号的内容原样送达程序，只过一层转义 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 超预算不静默：返回值与日志超过上限时按**结尾**保留（失败现场在尾部），并在 `notices` 里说清省略了多少 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 程序源码与 blobs 超过体量上限一律拒，不截断后照跑——半截程序跑出来的结果比不跑更坏 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 隔离必须**自证**才接活：子进程启动后先真去做一次该被拒绝的动作，证不出被关住就不把程序发进去（fail closed）。只相信命令行旗标不算数——`fork` 缺省用 `process.execPath`，宿主跑在 bun 下时那是 bun，它忽略 `--permission`，看着正常而隔离一点没生效 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 手滑写了 TypeScript 不废掉一整轮：整份诊断都落在「这个语法只能在 TypeScript 文件里用」那一族时，按 TypeScript 再查一遍（真类型错照样拦），剥掉类型照跑，并在 `notices` 里告诉模型下次直接写 JavaScript | 测试 | `spec/acceptance.test.ts` |
| INV-11 | `KernelScriptSession.edit` 按同一底稿精确替换：定位唯一、不重叠，主源码与附属模块全成或全不成；失败返回 SCRIPT_EDIT 和索引，原程序不变 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 诊断必须带代码帧：出错那一行连同一个指向出错列的插字符一起给出。只回行列号等于让模型靠数行定位，而数行是它最不准的事之一 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 宿主只提供本次授权能力的声明；程序引用未提供的能力时先拒绝执行并报告缺失命名空间；Kernel 会话按本次导入获取挂载声明，能力权限仍由 Kernel 校验 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | **我们发明的东西要导入，语言自带的不动**：`input` 与 `blobs` 走恒常可用的 `velaros:program` 模块，不做隐形全局——隐形全局是只有提示词告诉过模型才知道的暗知识；`console` 是 JavaScript 自带的，不动。`velaros:program` 由引擎提供 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 没跑完就交账：程序中止、超时或抛错时，**已经落定的能力调用逐条回给模型**（连着的同名同结果折成一条带 `times`），跑完了不给。这是**账**不是事务——不承诺回滚（跑过的命令回滚不了），承诺**知道**：工具面里中断落在两次调用之间、天然干净，程序里落在执行中途，副作用是真的，只回一个 `ABORTED` 等于让模型对着三个字瞎猜 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 内存也要封顶：隔离进程带 `--max-old-space-size` 起，堆爆时回 `TOO_LARGE` 并说清怎么改，不报成「意外退出」。超时管得住死循环，管不住一个循环里把整个仓库读进数组；子进程 stderr 必须有人收（没人收会把它堵死，而堆爆的现场只在那里） | 测试 | `spec/acceptance.test.ts` |
| INV-18 | **能力调用的时间不计进程序超时**：每次调用一开始就停表、落定后按剩下的预算接着走——命令跑多久由它自己的时限管，等用户点头也在调用里。必须在调用**开始**时停而不是结束后补时间：用户去倒杯水回来，程序早被我们自己杀了，而他刚点了同意。停表只扣调用那段，程序自己的计算照样按预算掐断 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 命名空间级的共同事实写在**操作接口头部**并带 `@AgentView`，生成进模块级注释：标记**之前**是给我们自己看的（实现类叫什么、进程里几份），标记**之后**才是模型面。方法上标记在第一行，于是整段都进模型面——同一条规则两处成立。没有这个位置时，「位置一律按字符算，没有行的概念」这类整族都成立的事只能在每个方法里抄一遍，抄漏是必然的 | 门禁 | `check:script` |
| INV-21 | 导出值、日志、通知、失败说明、调用账和含代码帧的诊断均受预算限制；整份结果另受 resultChars 上限约束，截断明确报告 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 导出照 ES 模块的样子交出，`export default` 与具名导出都行：只有 `export default` 就交它；有具名导出就交 `{ default?, ...具名 }`（跟 `import * as m` 同形），什么都没导出就是 undefined。`export default` **不中断执行**，它后面的代码照样跑。改写不挪模型写的任何一行，运行时报错的行号仍是模型写的那一行（能力报的错没接住时，是发起那次调用的那一行）——行号偏移在隔离进程启动时**量出来**，不写死（写死过一次，包装改了两行、行号一直差 3，从没被测出来） | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 能力交给模型的图走**结果旁边**的通道，不进返回值：程序拿不到像素，文字结果里没有 base64，`resultChars` 只算文字。一次程序最多交 20 张、合计 20 MB——张数对齐 API「一个请求超过 20 张图，每张都不得超过 2000 px」那条线；超出的按顺序丢后面的，并在插手记录里说明 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 程序停下时（跑完、失败、超时、被中止都算）还没落定的能力调用，会话触发这一轮的取消信号**叫停它们**，并按发出的顺序列进结果的 `unsettled`：发出去不等就交卷、或者死在一次调用中途，副作用都可能做了一半，模型得知道去核对哪几样 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | 程序数据模块 velaros:program 只导出本次 input 与 blobs，声明和运行时一致；模块模板统一由 velaros:system 的 modules.describe 按授权提供 | 测试 | `spec/acceptance.test.ts` |
| INV-33 | 附属模块来自提交的 modules，按相对路径解析并在单次运行中只初始化一次；类型诊断包含附属模块路径、行列与代码帧，运行错误可追踪 | 测试 | `spec/acceptance.test.ts` |
| INV-34 | output 在调用时捕获无环 JSON 快照，原始归档与有界预览分离；失败和中止保留已捕获块，采集问题不能被 catch 隐藏 | 测试 | `test/output.test.ts` |
| INV-35 | output 展示按类型保留结构和省略范围，正文与目录总量守展示预算；摘要同时匹配原值和任务代次 | 测试 | `test/output.test.ts` |
| INV-36 | 受限输出编辑只接受真实导入的顶层字面量声明，保持采集和用途不变，不执行脚本 | 测试 | `test/output.test.ts` |
