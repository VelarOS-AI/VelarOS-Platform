# 工作区知识库不变量登记

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

INV-1 到 INV-7 是原 `@velaros-ai/knowledge` 的登记，编号照旧；知识库整包并进本单元、三个工具换成代码面的 `velar:knowledge` 之后，
模型面这一层的承诺接在后面，从 INV-8 起。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 检索是只读的：有命中时既不同步也不重搜；只有零命中时补**一次**增量同步，同步补进了内容才重搜一次，并在结果里如实说明同步跑过（`autoSync`）；同步失败不改写检索的成败 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 工作区只认调用方给的或空间自己的那一个（经端口 `resolveWorkspace`）：两样都没有时报 `VALIDATION`，不猜一个根、也不跨根兜底；检索、同步与零命中补的那次同步都落在同一个根上 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 嵌入 profile 由 `provider + model + dimensions` 定义：任一不同就是另一个向量空间（另一张向量表）；同一文档内容变了就换一份行身份，旧索引不再复用——换模型不会删除或改写历史向量 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 工作区摄入只碰根内的条目：列文件只列根内的，根外的候选路径提示一律丢弃 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 删除一份文档时连带删掉它的分块与向量行，不留孤儿（**未验证**：要 SQLite 与 LanceDB 的原生依赖，收口那一轮随存储测试补上） | 文字 | |
| INV-6 | 嵌入配置每次向宿主端口要：本单元不读模型环境变量、不挑 provider，宿主换了模型下一次嵌入立刻用新答案 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 诊断只读：`diagnostics` 不同步、不检索、不重建 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 入参在做事之前核对：query 非空、来源类型只认常量表里的、提示与文档 id 不超上限、limit 是 1 到上限的整数；不合法当场 `VALIDATION`，端口一次都不调 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 交给模型的只有声明里的字段：命中文档的行身份、索引哈希、嵌入模型，诊断里的向量库路径与索引运行时键都不往外带 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 文件分工与对外边界不塌：三个操作在一个操作文件里、空间端口的每个方法都有操作在调；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；`./knowledge/contracts` 入口整条引用链不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-11 | 模型面是 `velar:knowledge`：声明从源码生成、只放出三个操作，随包发布的声明（`VelarKnowledgeModule`）与生成物是同一份；空间端口与调用上下文不进模型面；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 声明里写给模型的数字与取值就是常量表里的：limit 的缺省与上限、提示与文档 id 的条数（`KnowledgeSearchLimits`），来源类型（`KnowledgeSourceKinds`）；改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读（`velar:program` 的 template）；每个函数照写法跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
