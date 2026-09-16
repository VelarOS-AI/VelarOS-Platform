# office 空间不变量登记

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
| INV-1 | 读写目标按解开符号链接后的真实路径都在宿主给的工作区根内，越界一律拒绝，不写、不读 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 十个工具的入参里没有换执行目录的字段：路径只相对宿主给的工作区根，调用方换不了根 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 每次写盘前都拿到宿主的 `prepareMutation` 批准；被拒时返回跳过回执、一个字节都不写 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 目标已存在时不带 `overwrite` 不覆盖；只有 Word 的 appendMode 追加是例外 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 外部转换器只经宿主端口按原生 argv 执行，本包不拼 shell 串、不自己起进程 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 缺外部转换器或 MarkItDown 时返回带 `OfficeErrorCodes` 的结构化回执，不抛通用执行错误；装什么怎么装由宿主回答 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 预览 HTML 经 parse5 白名单净化，脚本与事件属性一律不落进产物 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 预览缺省不往用户的 HTML 里写自动刷新脚本，只有显式传 `autoRefresh: true` 才写 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 生成的文档不带产品名：作者、公司缺省留空，模板里也不盖水印 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 截断如实标记：MarkItDown 交回的是文档开头并标 `truncated`，预览摘要报的是文档里的真实数量而不是截后数量 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 文件分工与对外边界不塌：十个工具的定义在一个工具文件里；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，类、utils 函数、内部接口不出包；环境变量全部登记；渲染进程可加载的入口不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-12 | 十个工具的 schema 可由源码机械生成，工具名与宿主登记的归属一致 | 门禁 | `check:capabilities-schemas` |
