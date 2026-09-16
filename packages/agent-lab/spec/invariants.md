# 评测基础设施不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 结果只由独立验证决定：没有验证器判过的判据是 `void`，落成丢弃记录，段的 `passed` 与 `score` 都是未知；它既不进能力分子也不进分母，不被总分掩盖 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 一个试验失败不影响其它试验：`runJob` 当场停止派发、等在飞的试验收尾，再把第一个错误抛给调用方；不留「调用方已经拿不到归档、执行体还在后台跑」的会话 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 归档 v3 严格校验（未声明的字段一律拒收），v0/v1/v2 历史归档只读：缺的字段保持 `null`，不补、不改、不回写 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 真实任务报告不嵌入提示词、最终回答、绝对路径与产物正文；它只放度量与发现 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 工具调用按 `toolCallId` 去重计数（`unique-tool-call`）：累计快照重复上报同一次调用不重复计数 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 纯测量与渲染代码不做 I/O：`utils/measure/`、`utils/render/`、`utils/wire/` 不碰 Node 内置模块，也不发网络请求 | 门禁 | `check:agent-lab-package` |
| INV-7 | 两个入口由合同控制：`./contracts` 整条引用链不碰 Node 内置模块；zod schema 一个都不出包，外面只拿得到 `labWire` 的几个 `parse*` | 门禁 | `check:module-ownership` |
| INV-8 | 线格式的单一来源是手写类型：`utils/wire/` 的每个 schema 逐个 `satisfies z.ZodType<…>` 对齐它们，schema 与类型走形就编译不过（不再用 `as` 强转糊上） | 类型 | `src/types/agent-lab.ts::RunArchive` |
| INV-9 | 归档里的 harness 版本就是本包的真实版本（与 `package.json` 一致），不是写死的常量 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 预算分两本账：段预算按本段计（与驱动等待的计时口径一致），整程预算按整程累计；两者不混用 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 本包不认宿主：核心里不写任何产品的工具名与任何宿主协议的驱动——要按工具名判的两类由宿主注册内置探测器时给名单，认协议的驱动经 `labDrivers.register` 接进来 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 报告自包含：不联网、不拉任何外部资源；未知一律显示破折号并在 `data-value` 上标成 `null`，不借 0 表达 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 规范 JSON 的键按码点排序（不跟区域设置走）、`undefined` 不写成字面量：同一份内容在任何机器上给出同一个摘要，复跑可比性才作数 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 认证只认看得到的证据：任一项检查判不了，整份报告就是 `inconclusive`，不拿「没有证据」当通过 | 测试 | `spec/acceptance.test.ts` |
