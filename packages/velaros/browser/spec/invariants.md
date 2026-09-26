# 浏览器不变量登记

每一条都是本单元对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。编号只增不重排。

INV-1 到 INV-16 是原 `@velaros-ai/browser` 的登记，编号照旧。整包并进本单元、32 个工具换成代码面的 `velaros:browser` 与 `velaros:devtools` 之后（ADR 0011），
七条作废、编号不复用：INV-1（常驻集是主回路）、INV-2（每个工具恰好一个职责类别）、INV-3（客居空间由宿主传）、INV-4（客居可用不常驻）随工具面、
类别与随包 mod 清单一起作废——模块按需 import，空间由产品装配；INV-9（产物按类别落在固定目录）随站点产物管理删掉，站点工作区里的文件走 `velaros:files`；
INV-12（recipe 与当前站点同源）随 recipe 删掉，可复跑的自动化当时由脚本库接替（脚本库 2026-09-20 也已删除，现在只有会话内保存的程序版本）；INV-14（32 个工具的 schema 与已审基线一致）随工具面作废，模型面的承诺是 INV-17 起的几条。

ADR 0012 把一半操作换成页面脚本、加上输入原子与 `velaros:cdp` 之后，INV-17～19、21、23 的措辞跟着改（三件能力、删掉的操作不再列），
INV-24 起是新增的承诺：页面脚本的整份取回与失败码、fill 走真实输入、等待等不到就抛、state 与离站、模型 CDP 会话的隔离与兜底。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-5 | 地址栏判据只有一份：同一段输入，主进程与渲染进程经 `browserAddress` 得到同一个结论（是网址就导航，不是就按选定引擎搜） | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 偏好永远落在闭集里：读盘读到什么值，`browserPreferences` 都给出一个合法值，不抛也不返回未知值 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 动作策略按词表判定：拒绝名单命中即拒绝并说明命中了哪一条，没有策略表就是放行——判定只有 `browserActionPolicy.check` 这一处 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 站点工作区是硬边界：读写只在当前根（读可回退到历史根），`..`、绝对路径与指向根外的路径一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 用户脚本的命中规则只有一份：`@match` 先过、`@exclude` 一票否决，启用与否不改变匹配判定；程序建的用户脚本一律先停用 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 登录墙门控每个站点每会话最多问一次：问过就记账，之后无论批准还是拒绝都不再阻塞——死锁防护优先于反复征询 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | `./browser/contracts` 与 `./browser/renderer` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-15 | 2.5 MB 的 vendor 性能引擎只在真跑 trace 时才加载，且只有 `BrowserPerformanceTraceEngine` 一处加载它 | 门禁 | `check:module-ownership` |
| INV-16 | 同一个浏览器会话的动作串行：会话动作队列按会话排队，单个动作有占用上限，超时的动作不会把队列钉死（**未验证**：要真实 Electron 会话，留给真机验收） | 文字 | |
| INV-17 | 模型面是 `velaros:browser`、`velaros:devtools` 与 `velaros:cdp`：声明从源码生成，随包发布的声明（`VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule`）与生成物是同一份；空间端口与调用上下文不进模型面，工具时代的工具名、recipe、站点产物与 ADR 0012 删掉的操作都不在；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-18 | 声明里写给模型的数字就是常量表里的：看页面、输入、页面脚本、等待、诊断、页面条件、截图、性能、用户脚本与模型 CDP 会话的上限与缺省；改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 代码模版（`template.js`、`devtools-template.js`、`cdp-template.js`）是日常用法的示例程序（只是示例，模型按需要改写），import 只写一次；整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读；每个函数照写法跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 没进站点时，要页面的操作一律抛 `BROWSER_SITE_NOT_OPEN`，message 让模型先 open，端口上碰页面的方法一次都不调；state 在没进站点时照样回答（active 为假） | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 入参在做事之前核对：顶层是严格对象，形状、取值与上限不对当场 `VALIDATION`，message 点名操作与字段；元素目标至少要有一样定位线索；不合法时端口一次都不调 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 截图的图经交图通道交给模型，不进返回值：返回值只有落盘位置、尺寸、坐标换算、标注说明与比较；宿主没给交图通道时截图照样落盘并交回这些，只是不要压缩图 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 不替模型折叠：没给上限时，看页面、页面脚本的结果、读诊断、读响应体一律按常量表的上限向端口要，要多少由程序自己切 | 测试 | `spec/acceptance.test.ts` |
| INV-24 | 页面脚本（evaluate、waitForFunction）的结果按 JSON 整份交回程序，不截数组、不截深度；参数经 args 交进页面，不拼进源码；页面里抛错是 `BROWSER_SCRIPT_FAILED`（message 带错误名、原话与它在 script 里的行列），结果超过只为守住内存的上限是 `BROWSER_RESULT_TOO_LARGE`，不交半截 | 测试 | `spec/acceptance.test.ts` |
| INV-25 | fill 是真实输入：页面里全选，宿主像输入法一样插入（空字符串按退格），再读一次控件状态；不在页面里直接改 value——那样 React 的受控输入认不到 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 等待一个口径：waitForFunction 交回判定式为真的值，waitForLoad 交回页面状态，waitForEvent 交回事件；等不到一律抛 `TIMEOUT`，不回「没等到」的结果让程序带着没到位的页面往下走 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | state 进了站点时带上标签页与挂着的弹窗、下载、权限；离站（leave）先断开模型的 CDP 会话，它设的仿真与拦截不带到下一个站点 | 测试 | `spec/acceptance.test.ts` |
| INV-28 | 模型的 CDP 会话与宿主那条分开：模型开关的域、设的仿真与 Fetch 拦截只算在它自己身上，宿主的诊断、录屏与 mock 不受影响，宿主的事件监听不收子会话的事件；只认它自己挂出来的子会话（**未验证**：要真实 Electron，实现测试与真机探针在 `test/core/browser-protocol-sessions.test.ts` 与 ADR 0012 的验证里） | 文字 | |
| INV-29 | 被模型的 Fetch 拦下、30000 毫秒没人放行的请求由宿主放行，并在事件里记一条 `Velar.requestAutoContinued`；事件序号只增，缓冲只为守住内存、挤掉的条数如实交回（实现测试在 `test/core/browser-protocol-sessions.test.ts`，经空间端口的那一段要真实浏览器） | 文字 | |
