# Agent Lab 产品架构与不变量

## 产品边界

`@velaros-ai/agent-lab` 是 host 无关的评测产品包，不是 Desktop 的脚本目录。它提供稳定协议、公开 API、CLI、
机械门、归档和报告；Desktop 只拥有真实产品任务、fixture、Velar Hooks Driver 配置和产品判据。

```text
产品仓任务与 verifier ─┐
内部 / Codex / Claude Driver ─┼─ Agent Lab runner ─ v3 archive ─ report / statistics / certification
residency 原账本 ───────┘
```

传统 benchmark item 用一个 leg 表示；VelarOS 产品评测默认是多个 leg 复用一个 session 的 Journey。runner
不允许按 leg 重开会话，因此上下文累积、权限状态、工具副作用和文件变更都属于被测行为。

## 模块职责

| 模块 | 唯一职责 | I/O 权限 |
| --- | --- | --- |
| protocol | 版本化数据语言与严格 parser | 纯函数 |
| detect | 观测归一化、确定性探测器、看门狗判据 | 纯函数 |
| runner | 单会话旅程、预算、矩阵调度、verifier 调用 | 只经 Driver / Verifier |
| drivers | 执行体原生生命周期与收敛语义 | 可访问进程、HTTP、产品控制面 |
| archive | v3 原子写入与历史只读视图 | 文件系统 |
| report | 确定性、自包含、未知保真的 HTML | 纯函数 |
| statistics | 配对簇估计、可靠性与失败分布 | 纯函数 |
| certification | 策略化基础设施认证结论 | 纯函数 |

架构门禁止纯模块导入 Node I/O、网络或 Electron，也禁止包依赖其他 VelarOS 产品包。Driver 是唯一允许认识
宿主的地方。

## 不变量

1. 一个 trial 只打开一个原生 session；全部 leg 顺序推进。
2. Driver 对 native settle 负责。不能拿内部 agent event 判断外部引擎 idle。
3. 共享环境、预算、评测协议与原生执行是跨执行体可比的前置条件，不是报告备注。
4. 工具调用口径是全局唯一 `toolCallId`；累积快照只记首见调用。
5. `null` / `void` / coverage `none` 代表未知；不得转成 0、false、空证据或失败。
6. verifier 与被测环境应隔离；不能隔离就必须在 capability 与认证结果中显式降级。
7. 历史归档只读。读者按 v0/v1/v2/v3 分支解释，不迁移、不回填。
8. 同一份归一化观测和同一版本 detector 永远产生同一 Finding。
9. 每份归档锚定 Platform source commit、consumer commit、任务/判据摘要和执行体身份。
10. residency 数据只投影现有迁移账本，不建立第二事实源。

## 失败闭集与丢弃

能力失败按 `FailureClass` 分类，用来回答“差在哪一类”；环境/基础设施导致无法测量时使用 `AttritionCause`。
两者不能互换。Verifier 抛错是 `verifier-failure`，setup 漂移是 attrition，agent 在共享预算内超时才是能力侧
`timeout`。未覆盖现象保留 `unclassified`，之后通过协议版本演进收敛，不能硬塞进最近的类别。

## 认证边界

当前 `certification@1` 产出可复算摘要和策略检查结果，但不是密码学签名或透明日志。第三方生态上线前还需在
服务侧增加受控执行环境、签名证书、撤销与审计日志；这些信任基础设施不能伪装成包内已经提供的能力。
