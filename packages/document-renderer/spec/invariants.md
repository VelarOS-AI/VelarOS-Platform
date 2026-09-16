# 独立文档渲染器不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 一个进程恰好一条 JSON 回执：`--request-json` 后面缺参数、值不是合法 JSON、标准输入不是 JSON，都收成带错误码的回执写 stdout，退出码 1；成功退出码 0 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 三条路径（projectRoot、inputPath、outputPath）解开符号链接后都必须仍在 projectRoot 内；越界时先拒绝再谈落盘，projectRoot 之外一个目录都不建 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | outputPath 不许是符号链接：链接指向的文件一个字节都不动，直接 PATH_DENIED | 测试 | `spec/acceptance.test.ts` |
| INV-4 | `describe` 报的版本就是 `package.json` 的 version：代码里只有 `DocumentRendererProtocol.packageVersion` 这一处，打包脚本按它核对可执行文件的身份 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 失败回执只有 `contract/constants.ts` 里的四个错误码，`message` 是一句中文（字段路径与期望原样夹在里面），不是 zod 的原始 issue 文本 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 名字以 `..` 开头的目录（`..cache`）照常算在 projectRoot 里，不当越界；包含判断走 `@velaros-ai/platform` 的公共件，不自己写 `startsWith('..')` | 测试 | `spec/acceptance.test.ts` |
| INV-7 | `./contracts` 入口整条引用链不碰 Node 内置模块：只想按协议拼请求、读回执的调用方引它就够；schema 与渲染实现不出包 | 门禁 | `check:module-ownership` |
| INV-8 | 请求形状的单一来源是手写类型：`utils/request.ts` 的每个 schema 都 `satisfies z.ZodType<…>` 对齐它，schema 与类型走形就编译不过 | 类型 | `src/types/rendering.ts::DocumentRendererRequest` |
