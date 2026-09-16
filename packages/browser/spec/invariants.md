# 浏览器能力不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 常驻集就是「进站 — 看 — 动 — 取 — 等」那条主回路：`browser:enter_site` 一定在里面，否则未进站点时其余工具全隐身、模型无从开始 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 每个工具恰好属于一个职责类别，七个类别的并集等于工具全集：漏登记一个工具就当场抛错，不让它静默落进没人认识的分类 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 客居空间由宿主传：本包的 mod 清单只认自己的浏览器空间，`createBrowserBundledModDefinition({ guestSpaceIds })` 不传就不挂到别的空间上 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 客居 = 可用不常驻：客居空间里工具可用，但 `residentInSpaces` 只写浏览器空间——否则每个项目会话每轮都要背上浏览器的 schema | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 地址栏判据只有一份：同一段输入，主进程与渲染进程经 `browserAddress` 得到同一个结论（是网址就导航，不是就按选定引擎搜） | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 偏好永远落在闭集里：读盘读到什么值，`browserPreferences` 都给出一个合法值，不抛也不返回未知值 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 动作策略按词表判定：拒绝名单命中即拒绝并说明命中了哪一条，没有策略表就是放行——判定只有 `browserActionPolicy.check` 这一处 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 站点工作区是硬边界：读写只在当前根（读可回退到历史根），`..`、绝对路径与指向根外的路径一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 产物按类别落在固定目录：截图、提取、页面快照、recipe、运行记录各有自己的目录与扩展名，命名规则只有一份 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 用户脚本的命中规则只有一份：`@match` 先过、`@exclude` 一票否决，启用与否不改变匹配判定 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 登录墙门控每个站点每会话最多问一次：问过就记账，之后无论批准还是拒绝都不再阻塞——死锁防护优先于反复征询 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | recipe 产物与当前站点同源：读一份骨架、跑一次 recipe 之前先核同源，不同源当场报错而不是读出别的站点的东西 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | `./contracts` 与 `./renderer` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-14 | 模型面 32 个工具的入参 schema 与已审基线逐字节一致，改一个字段就要重绑基线 | 门禁 | `check:capabilities-schemas` |
| INV-15 | 2.5 MB 的 vendor 性能引擎只在真跑 trace 时才加载，且只有 `BrowserPerformanceTraceEngine` 一处加载它 | 门禁 | `check:module-ownership` |
| INV-16 | 同一个浏览器会话的动作串行：会话动作队列按会话排队，单个动作有占用上限，超时的动作不会把队列钉死（**未验证**：要真实 Electron 会话，留给真机验收） | 文字 | |
