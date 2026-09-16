# 工作区知识库不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 检索是只读路径：有命中时既不同步也不重搜；只有零命中时工具层补**一次**增量同步再重搜一次，并在回执里如实说明同步跑过 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 工作区根只认调用方给的或宿主当前激活的那一个；两个都没有时报 `VALIDATION`，不猜一个根、也不跨根兜底 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 嵌入 profile 由 `provider + model + dimensions` 定义：任一不同就是另一个向量空间（另一张向量表）；同一文档内容变了就换一份行身份，旧索引不再复用——换模型不会删除或改写历史向量 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 工作区摄入只碰根内的条目：列文件只列根内的，根外的候选路径提示一律丢弃 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 删除一份文档时连带删掉它的分块与向量行，不留孤儿（**未验证**：要 SQLite 与 LanceDB 的原生依赖，收口那一轮随存储测试补上） | 文字 | |
| INV-6 | 嵌入配置每次向宿主端口要：本包不读模型环境变量、不挑 provider，宿主换了模型下一次嵌入立刻用新答案 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 诊断只读：`knowledge:diagnostics` 不同步、不搜索、不重建 | 测试 | `spec/acceptance.test.ts` |
