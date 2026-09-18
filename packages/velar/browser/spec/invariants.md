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

INV-1 到 INV-16 是原 `@velaros-ai/browser` 的登记，编号照旧。整包并进本单元、32 个工具换成代码面的 `velar:browser` 与 `velar:devtools` 之后（ADR 0011），
七条作废、编号不复用：INV-1（常驻集是主回路）、INV-2（每个工具恰好一个职责类别）、INV-3（客居空间由宿主传）、INV-4（客居可用不常驻）随工具面、
类别与随包 mod 清单一起作废——模块按需 import，空间由产品装配；INV-9（产物按类别落在固定目录）随站点产物管理删掉，站点工作区里的文件走 `velar:files`；
INV-12（recipe 与当前站点同源）随 recipe 删掉，可复跑的自动化由脚本库接替；INV-14（32 个工具的 schema 与已审基线一致）随工具面作废，模型面的承诺是 INV-17 起的几条。

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
| INV-17 | 模型面是 `velar:browser` 与 `velar:devtools`：声明从源码生成，随包发布的声明（`VelarBrowserModule`、`VelarDevtoolsModule`）与生成物是同一份；空间端口与调用上下文不进模型面，工具时代的工具名、recipe、站点产物都不在；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-18 | 声明里写给模型的数字就是常量表里的：看页面、动手、等待、取内容、求值、诊断、页面条件、截图、性能与用户脚本的上限；改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 代码模版（`template.js`、`devtools-template.js`）是日常用法的示例程序（只是示例，模型按需要改写），import 只写一次；整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读；每个函数照写法跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 没进站点时，要页面的操作一律抛 `BROWSER_SITE_NOT_OPEN`，message 让模型先 open，端口上碰页面的方法一次都不调；state 在没进站点时照样回答（active 为假） | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 入参在做事之前核对：顶层是严格对象，形状、取值与上限不对当场 `VALIDATION`，message 点名操作与字段；元素目标至少要有一样定位线索；不合法时端口一次都不调 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 截图的图经交图通道交给模型，不进返回值：返回值只有落盘位置、尺寸、坐标换算、标注说明与比较；宿主没给交图通道时截图照样落盘并交回这些，只是不要压缩图 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 不替模型折叠：没给上限时，看页面、找元素、取表格列表正文、读诊断、读存储、列媒体、读响应体一律按常量表的上限向端口要，要多少由程序自己切 | 测试 | `spec/acceptance.test.ts` |
