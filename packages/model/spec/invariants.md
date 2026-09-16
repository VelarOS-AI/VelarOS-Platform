# model 域不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 解析只在同一个 provider 内回退模型，绝不换 provider：provider 不可用一律报错并给自救动作 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 没有模块级单例：两份运行时对象图之间 provider script、Cloud 绑定、目录缓存一概不串 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 未注册的 Cloud 服务直接报 `cloudNotConnected`，不回落 OpenRouter，也不换另一个 Velar 服务 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 可移植面不发现宿主进程：`modelCatalog` 的环境值只能由调用方显式给，本包从不读 `process.env` | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 缺凭据是错误码不是文案：`ModelErrorCodes.credentialMissing`，调用方按码分支 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | agent 侧入口收 `unknown` 并在那里一次性收窄：形状不对当场拒绝，不做业务回退 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 内核 wire 面只开 `supports_provider` 一条操作，入参严格解析，未知字段当场拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 静态目录与常量表始终一致：每个内置 provider 的缺省模型、清单与目录逐条对得上 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | token 账本永远非负；查不到单价就不算钱，不按别的模型的价估一个数 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 文件分工与对外边界不塌：合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，类、utils 函数、内部接口不出包；环境变量全部登记 | 门禁 | `check:module-ownership` |
| INV-11 | `./catalog` 与 `./contracts` 的整条引用链不碰 Node 内置模块、不读宿主进程环境；根入口不出任何类 | 门禁 | `check:model-arch` |
