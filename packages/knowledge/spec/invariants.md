# 工作区知识库不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

INV-1（检索只读、零命中补一次同步）、INV-2（工作区根只认给的或空间的）、INV-7（诊断只读）是工具那一层的承诺：三个知识工具换成代码面的 `velar:knowledge` 之后，它们随工具搬到 `packages/velar/knowledge/spec/invariants.md`（那边的 INV-1 到 INV-3），这里的编号不复用。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-3 | 嵌入 profile 由 `provider + model + dimensions` 定义：任一不同就是另一个向量空间（另一张向量表）；同一文档内容变了就换一份行身份，旧索引不再复用——换模型不会删除或改写历史向量 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 工作区摄入只碰根内的条目：列文件只列根内的，根外的候选路径提示一律丢弃 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 删除一份文档时连带删掉它的分块与向量行，不留孤儿（**未验证**：要 SQLite 与 LanceDB 的原生依赖，收口那一轮随存储测试补上） | 文字 | |
| INV-6 | 嵌入配置每次向宿主端口要：本包不读模型环境变量、不挑 provider，宿主换了模型下一次嵌入立刻用新答案 | 测试 | `spec/acceptance.test.ts` |
