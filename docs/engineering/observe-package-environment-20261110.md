# Node 包环境查询转发修复（2026-11-10）

以已合入 main 的 `7f4958ac` 为基点。Desktop 的真实 npm 环境装配证明，0.9.4 的 `withPackageEnvironment()` 丢失了宿主 `observationSupport()`，实际不支持原因退化成通用的「宿主未声明」。同链检查还发现 RuntimeBootstrap 创建只读 Node 运行器时遗漏该查询，以及默认子进程运行器未公开转发内部查询。

## 差量与合同

- Node/npm 两处装饰器通过 getter 在每次查询时绑定原方法，保留原 receiver、状态对象与原因。宿主方法或报告变化后，后续查询读取新值；不缓存结果，不以操作系统猜测，也不增加普通执行回落。
- `createNodeCodeRunner()` 返回新增的 `NodeCodeRunnerApi`，明确保证已有的 `observationSupport()` 方法存在。通用注入端口 `CodeRunnerApi` 仍允许缺失查询，缺失仍由 Node 运行器如实报告不可用；这不是把宿主支持变成默认 true。
- `nodeSubprocessCodeRunner` 转发真实内部运行器的查询。Script INV-5、Runtime 的 Node/npm 边界承诺与 README 同步；其他权限、租约、审批和执行方法不变。

## 行为证明

沿公开 `createNodeExecutionEnvironment`、`createRuntime`、`createNodeRuntime` 和真实 `createEnvironmentRegistry` 装配；同时使用带原型方法的 Node 适配器及带私有字段的宿主，核对 receiver。原版本复现：真实宿主理由被通用未声明理由替代。修复后逐次核对不支持→支持→不支持及方法替换，返回原状态对象和完整原因，查询不启动普通或只读命令。

该测试证明查询与装配链，没有执行或声称成功的只读进程，也不证明供应商模型行为。旧 0.9.4/v0.7.5 的验证和归档保持不变；本次采用新的 `v0.7.6`、基础包与能力包 `0.9.5`、Script `0.4.3`。正式 CI 与同一归档 JavaScript/严格声明消费结果记录于新发行 manifest 和 validation，不混用旧发行证明。

发行归档消费新增一个只读查询夹具：在 workspace 外安装本次基础包字节，经公开 Node 工厂、真实 npm 环境和公开 instruction manifest 核对实时支持、原因、receiver 与方法替换；命令执行入口被设为立即失败。严格声明夹具直接调用工厂保证存在的查询。两项与原有 JavaScript 消费共用同一个基础归档，公开收据新增 `nodeEnvironmentQuery` 及夹具/输出摘要；发布前要求它为 true。

本地真实装配回归、Script/Velaros 构建和类型检查、INV-5、格式、module ownership 与发行预检通过。正式打包器的基础包候选演练完成同归档 JavaScript、Node/npm 查询和 `strict: true` / `skipLibCheck: false` 消费；演练不作为正式发行身份或字节证明。默认 CI 增加本次装配回归，正式发行仍从精确 tag 重新构建并验证实际发布归档。
