# 代理面线格式不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 五种载荷一律严格校验：未声明的字段即拒；失败只给出 `{ path, code }` 列表，载荷值一个字都不带出来（观察器与日志因此可以直接记问题列表） | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 回执携带的附件有界：条数、单个 base64 长度、文件名长度、图片类型全部按 `contract/constants.ts` 的常量表卡，两端同一组数字 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 目录载荷用 `revision`，调用与回执回显成 `catalogRevision`；两个名字不混用 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 协议版本冻结为 1：目录、调用、回执都带它，对不上就拒收 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | `createBinding` 造出的绑定一定过得了 `checkBinding`；provider 为空、时间戳不是非负整数毫秒时当场抛错，不把两端判定不一致的绑定放上桥 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 两个入口整条引用链不碰 Node 内置模块，浏览器扩展与渲染进程都能直接加载；zod schema 不出包，外面只拿得到 `providerSurfaceWire` 的 `check*` | 门禁 | `check:module-ownership` |
| INV-7 | 线格式的单一来源是手写类型：schema 逐个 `satisfies z.ZodType<…>` 对齐它们，schema 与类型走形就编译不过 | 类型 | `src/types/surface-protocol.ts::ProviderSurfaceToolCall` |
