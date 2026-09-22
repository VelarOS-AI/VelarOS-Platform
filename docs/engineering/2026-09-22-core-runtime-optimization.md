# 核心运行时性能与评测差量

## 本批实现

1. **记录追加。** ContextStorage 增加可选 `appendRecord`。SQLite 在同一事务中验证正文、同会话来源和唯一记录身份，按索引取得末尾序号，追加记录并递增状态版本。SessionContext 优先调用该端口；其他适配器继续完整 CAS。工作集、任务状态、跨连接 CAS、归档正文和失败回滚的承诺保持一致。
2. **效果调度。** Runtime 增加宿主 `effectResources(invocation)` 配置。只有宿主声明的完整冲突资源集合互不相交时才并行；默认或未知范围仍与全部写操作互斥。全局等待者阻挡后续写操作，取消队列节点不会释放活动处理器，派发前继续检查取消、权限和决策版本。
3. **计量。** Act 原有请求/响应记录包含单调时钟的准备和模型耗时，脚本结果包含执行耗时。ActTurnTrace.timing 缺失值为 null；首个请求记录准备耗时，重试不重复累计。RuntimeMetric/onMetric 提供 ContextStorage 方法与效果等待/运行计量，异常接收器不改变业务结果，StoreStorage 内部操作不单独采样。
4. **重复评测。** `eval:act` 支持 `--scenario all --repeat N`，逐个运行已有四个正式 Runtime 场景。每次保留独立工作区、原始追踪和外部判据；批次持续保存 progress.json，最终记录成功率、已测时长分位数、已知用量。失败尝试保留在分母，缺失用量不按零处理。单次汇总增加 requestRetries、protocolRejections 和阶段计量；模型用量缺失时仍为 null。
5. **追踪读取。** trace 分页共用一次元数据快照；来源链按引用索引遍历，调用日志按关联 executionId 查询。真实调用回执仍可能继续结算，trace 不冻结外部执行。旧记录没有计量时返回 null。

## 合同与验收变化

| 合同 | 理由与影响 |
| --- | --- |
| ContextStorage.appendRecord | 可选优化端口；现有只实现完整 CAS 的后端继续可用。实现者必须通过追加、跨连接、来源/正文拒绝与回滚验收。 |
| VelarosRuntimeOptions.effectResources | 宿主声明规范化冲突身份，需涵盖读写依赖与别名；不由模型指定，不替代领域锁。未配置的实例继续串行。 |
| VelarosRuntimeOptions.onMetric、RuntimeMetric | 宿主采样接口；只传阶段、身份和耗时，不采集正文/参数/资源路径。回调应快速返回，异步结果不进入运行等待链。 |
| ActTurnTrace.timing | 新增数据字段；准备、流消费和执行可能嵌套，不能直接相加当作任务墙钟时间。模型耗时包含消费者处理，不是纯供应商延迟。 |
| Runtime INV-41 / INV-42 | 新增资源调度与诊断隔离承诺。Context INV-12 扩展覆盖可选追加；原有验收承诺保持。 |

模型操作、schema、发现内容和使用模板没有变化。工作区装配/绑定中的现有写法同步使用仓库公共判断函数以通过风格门。

## 可重现基准

先构建 Context，然后运行：

```sh
bun run --cwd packages/context build
node scripts/agent/benchmark-context-storage.mjs
```

基准在独占临时目录建立真实 SQLite，两个路径使用相同历史、FULL 持久性及来源验证；CAS 路径通过省略可选端口测量。每组 20 次追加，完成后核对记录数与状态版本并清理目录。2026-09-22 本机 Node v24.15.0 / macOS arm64 的一次结果：

| 历史记录 | 路径 | p50 ms | p95 ms |
| ---: | --- | ---: | ---: |
| 1,000 | 完整 CAS | 3.725 | 5.594 |
| 1,000 | 原子追加 | 0.220 | 1.250 |
| 10,000 | 完整 CAS | 53.809 | 111.495 |
| 10,000 | 原子追加 | 0.145 | 0.230 |

这是固定追加负载的单次微基准，受缓存和运行环境影响；不是整轮任务加速比例。完整状态 load/CAS 仍处理全部记录目录，SQLite 仍在当前线程执行。

真实模型重复评测入口：

```sh
bun run eval:act --model-config /absolute/model.json --output /absolute/results --scenario all --repeat 3
```

本轮使用确定性模型回归正式 Runtime，没有进行真实供应商请求；模型与凭据由上述显式配置接入。

## 下一批已定位

1. **元数据事务与调用索引的完整快照成本。** LocalContextStorage.load/compareAndSwap 仍遍历记录目录；ContextInvocationJournal.index 的追加也使用完整 CAS。下一步应分别测量任务续租、预算记账和日志索引，建立增量元数据/目录提交合同。需要保留跨连接冲突、同版本一致性与故障回滚，不能用实例缓存代替数据库权威。
2. **评测归档对长任务的附加成本。** act-eval 的 saveEvidence 每个 turn 和周期快照都会重读已累计回合。下一步应区分活动回合、在途执行与已稳定回合，保存增量归档；异步结果及下一回合关联完整之前不能把旧 trace 当作最终事实。
3. **同步 SQLite 的事件循环占用。** 当前优化缩短单次追加，但完整快照和大查询仍同步执行。先用阶段采样和事件循环延迟基准验证，再决定 Worker 适配器；连接关闭、取消与事务排队需要独立验收。
4. **真实模型统计基线。** 批次运行器已具备，接下来需要固定模型配置与源码身份，跑多次四场景矩阵，再根据成功率和成本数据调整上下文策略；确定性通过不能替代真实模型质量证明。

## 验证

- Context、Agent、Velaros 构建及类型检查通过。
- Context 五组行为/存储测试：64 通过、0 失败；1 项可选追加测试在不实现该端口的内存后端上跳过，通用 CAS 路径仍通过。最终存储定向复验为 20 通过、1 项相同跳过。
- Agent 回归：22 通过、0 失败。
- Runtime、恢复、子任务、长任务与评测的较完整回归：87 通过、0 失败，包含现有 80 次真实状态推进用例。
- 最后调整后的调度、诊断、trace、文本运行和评测定向复验：38 通过、0 失败；另有工作区装配/绑定 7 项通过。各组有重叠，不合并成唯一测试总数。
- `check:module-ownership`、`check:code-style` 的 37 项检查、Agent 架构/API/schema、会话语义门、修改源码及脚本的 ESLint、`git diff --check` 通过。
- 完整仓库 `bun run check`、真实供应商调用和宿主产品端到端验收本轮未执行。
