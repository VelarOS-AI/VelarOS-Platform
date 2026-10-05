# 内核不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。

编号只增不重排。本表按方案 `docs/engineering/refactor-plans/kernel.md` §2.7 落成；远程节点那几条（INV-17 到 INV-20）
本仓没有实现测试，由 Termel 仓的 `remote-node.e2e.test.ts` 跨仓覆盖，这里按「文字」登记并在检验器一列留空，
等远程节点的本仓测试补齐再改成「测试」。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 没注入权限策略时，任何声明了权限的操作一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 未知操作在求权限之前就拒绝，不论服务来自进程内模块还是隔离适配器 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 声明的每一条权限都在 provider 代码运行前逐条判定，一条拒绝就不调用 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 模块只能解析自己声明过的能力（provides / requires / optionalRequires） | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 模块不能冒充模块 id、代数或调用方 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 替换模块失败不影响现有代；替换成功后旧代句柄立即失效 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 一个事件订阅者失败不影响其他订阅者与发布方 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 组合快照只读、确定、冻结，降级态也给得出 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 进程内与 serve 共用一条调用路径 | 门禁 | `check:kernel-arch` |
| INV-10 | wire schema 与已审快照一致 | 门禁 | `check:kernel-schemas` |
| INV-11 | 根入口与 `./contracts` 的引用链不碰 Node 模块 | 门禁 | `check:module-ownership` |
| INV-12 | client 不引 runtime / serve，updater 不引别的切片，remote 两侧互不引用 | 门禁 | `check:kernel-arch` |
| INV-13 | 协议只接受完全相同的版本，异版本给出升级方向 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 能力会话之外的调用一律 `CAPABILITY_NOT_GRANTED`，会话不跨连接 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 本机 RPC：descriptor 与锁文件 0600、运行目录 0700 且属主是自己 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 单实例锁与更新锁：活着的持有者不会被抢 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 远程节点：签名通过前收到的调用一律断开 | 文字 |  |
| INV-18 | 远程节点：一个 callId 恰好一帧终态，重连后同一 callId 回放已有结果 | 文字 |  |
| INV-19 | 远程节点：对端重启后在途调用按「结果未知」上抛 | 文字 |  |
| INV-20 | 配对码常数时间比较、失败锁定，重开窗口不清零 | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 更新器：大小与 SHA-256 核对通过才落位，安装经原子改名，健康检查失败回滚指针 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 模块 API 版本、协议版本只从常量表引用，不复制数字 | 门禁 | `check:kernel-arch` |
| INV-23 | `KernelModulePermissionRequest` 没有 `callerModuleId` 字段 | 类型 | `src/types/kernel.ts::KernelModulePermissionRequest` |
| INV-24 | 供应商延续状态封套有界并保持为 assistant 历史的独立字段，正文编码不会把不透明数据拼成模型材料；原生结果正文的可选绑定只匹配前一条 assistant 的真实调用，拒绝重复、越界、错名和非文本正文，逻辑历史与原文保持完整 | 测试 | `spec/model-continuation.test.ts` |
| INV-25 | 调用诊断独立冻结且有界，超长显式标记；成功、处理器失败、输出校验失败均保存诊断，同号重放不重复执行，不据诊断修改成败或效果 | 测试 | `spec/operation-diagnostics.test.ts` |

## INV-26 取消观察与真实生命周期分离

prepare、beforeDispatch、handler、领域 reconcile 即使不响应 signal，也不能让调用方无限等待取消。调用方取消只结束观察；真实调用仍持有身份、锁、模块和日志资源，pending 显示阶段和取消请求。关闭默认有界等待，超时返回 TIMEOUT，后台只在真实收束后回收资源。迟到 committed 写入真实回执，派发前取消不进入 handler。

验证：`spec/operation-lifecycle.test.ts`。

## INV-27 模式合同必须同源

生成合同与挂载运行时的 allowedModes 按有效集合一致；省略等价于 execute 与 observe。非法、空或重复模式集合在装配期拒绝。

验证：`spec/operation-lifecycle.test.ts`。

## INV-28 自动历史管理的模型状态

声明 automaticHistory 的容量报告保留完整宿主诊断，编码到模型的状态只包含模式、阶段、自动归档说明以及当前过载与停滞；输入段余量不作为模型任务预算展示。原始请求及用户材料不修改，work、maintenance、finalizing 阶段保持原值。声明缺省时兼容完整报告编码。

验证：`spec/model-continuation.test.ts`。
