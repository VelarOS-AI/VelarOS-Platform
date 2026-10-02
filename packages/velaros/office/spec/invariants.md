# 办公文档不变量登记

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

INV-1 到 INV-12 是原 `@velaros-ai/office` 的登记，编号照旧。整包并进本单元、十个工具换成代码面的 `velaros:office` 之后，三条作废、编号不复用：
INV-3（写盘前向宿主申请授权，被拒一个字节都不写）随 ADR 0009 拆掉——写盘不问人，出了工作区根一律拒绝就是全部边界；
INV-6（缺转换器返回结构化跳过回执）改成抛带专属码的错误，程序只看得到 code 与 message，新承诺是 INV-13；
INV-12（工具 schema 由源码生成）随工具面一起作废，模型面的承诺是 INV-15 起的几条。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 读写目标按解开符号链接后的真实路径都在空间给的工作区根内，越界一律拒绝（`OFFICE_PATH_OUTSIDE_PROJECT`），不写、不读；空间给的路径换算（`resolvePath`）只决定路径怎么解析，换出来的照样按根判 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 九个操作的入参里没有换执行目录的字段：路径只相对空间给的工作区根，多给 cwd 这类字段当场拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 目标已存在时不带 `overwrite` 不覆盖（`OFFICE_OUTPUT_EXISTS`），原文件一个字节不动；只有 Word 的 appendMode 追加是例外 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 外部转换器只经空间端口按原生 argv 执行，本单元不拼 shell 串、不自己起进程 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 预览 HTML 经 parse5 白名单净化，脚本与事件属性一律不落进产物 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 预览缺省不往用户的 HTML 里写自动刷新脚本，只有显式传 `autoRefresh: true` 才写 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 生成的文档不带产品名：作者、公司缺省留空，模板里也不盖水印 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 截断如实标记：预览摘要报的是文档里的真实数量而不是截后数量，列出的条目按 maxItems 截断 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 文件分工与对外边界不塌：九个操作在一个操作文件里、空间端口的每个方法都有操作在调；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发；环境变量全部登记；随包资产写进包清单；渲染进程可加载的入口不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-13 | 缺外部转换器或 MarkItDown 时抛带专属码的错误（`OFFICE_CONVERTER_MISSING`、`OFFICE_MARKITDOWN_UNAVAILABLE`），message 说清缺哪个、为什么要它，并请模型如实告诉用户、不要自己去装；外部命令失败抛 `OFFICE_CONVERSION_FAILED`，message 带命令输出的结尾，LaTeX 的 .tex 源码留在原处可改 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 入参在做事之前核对：形状、取值与上限不对当场 `VALIDATION`，message 点名字段；正文与结构化内容（content 与 blocks、slides、sheets）只给一样；不合法时空间端口一次都不调、一个文件都不写 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 模型面是 `velaros:office`：声明从源码生成、只放出九个操作，随包发布的声明（`VelarOfficeModule`）与生成物是同一份；空间端口与调用上下文不进模型面；能由别的操作拼出来的不单做（PDF 转 Word 就是 readPdf 加 createWord）；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 声明里写给模型的数字就是常量表里的：路径、标题、作者、正文、内容块、页、条目这些上限（`OfficeInputLimits`、`OfficePdfLimits`、`OfficeMarkdownLimits`、`OfficePreviewLimits`）与 MarkItDown 认的扩展名；改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读（`velaros:system` 的 modules.describe）；每个函数照写法跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-18 | 写之前就停下的失败（入参不对、路径越界、目标已在、输入不在、缺转换器或 MarkItDown、Word 追加目标不完整）都标成没有写入（`executionOutcome: 'not-applied'`），运行时据此记成没有效果；转换后的失败保留已知事实：LaTeX 的 .tex 已写时标 applied 并列出源码路径，原转换错误码与原因保留；无法确认的外部副作用不冒称没有效果 | 测试 | `spec/acceptance.test.ts` |
| INV-19 | preview 与 toMarkdown 声明为写，但不给 outputPath 时只是读：调用上下文给了 `recordEffect` 就登记成没有效果（入参核对之后、做事之前），运行时不把它们算成写入；给了 outputPath 照声明记成写入 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 报告与表格模板把原始数据直接交给生成 API，再按真实产物路径解析；输出分别保留写入回执、实际结构计数、条目范围和正文截断，不将结构可解析声明成布局或全部内容验收通过 | 测试 | `spec/acceptance.test.ts` |
