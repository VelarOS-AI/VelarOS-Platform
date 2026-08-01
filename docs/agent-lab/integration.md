# Agent Lab 接入手册

## 新执行体

优先实现 `PollingDriverAdapter`，由 `createPollingDriver` 统一施加稳定 idle、预算、确认策略和看门狗；只有原生
执行模型不适合轮询时才直接实现 `LabDriver`。

接入清单：

1. `identity()` 报告 adapter/CLI/model/revision/reasoning/config；拿不到就 `null`。
2. `capabilities()` 逐观测面声明 full/partial/none，并声明 settle signal、abort、approval、verifier isolation。
3. `openSession()` 创建 trial 级原生会话；`send()` 只追加当前 leg，不能重开会话。
4. `readState()` 使用该执行体权威状态。内部 agent 可读 agent events，外部 engine 应读 coordinator/process。
5. `revision` 必须在新完成输出出现时变化，用来挡住“尚未起跑时 running=false”的竞态。
6. `collect()` 投影 transcript、turn、usage、runtime、artifacts 与原 residency ledger；工具调用按稳定 id。
7. 真机测 approval、abort、待输入、app 重启、空闲间隙和归档落盘延迟。

Velar Hooks 适配器已完成 HTTP 重试、Bearer endpoint 发现、runtime/transcript/debug 投影和确认/中止。产品侧把
execution binding 放到 `resolveSpace` / `commandExtras`，用 `sendParameters` 只挑出合法 hook 字段；不要把
中止、双发、故障注入等产品控制参数泄漏到 hook 命令，也不要在任务文件写死 Codex / Claude 私有协议。

## 新任务

任务必须是可审阅的版本化纯数据：fixture 能恢复、hygiene 明确、每个 leg 有产品含义、预算有依据、判据尽量读
磁盘真相。修改 prompt、fixture、leg 顺序、预算或 criterion 都要提升版本。任务注册门应锁 id/version/digest，
防止“同版本偷偷变题”。

连续旅程的 leg 不应拆成散装测试。若某一步失败后继续执行没有意义，标 `blocking: true`；否则允许后续步骤继续，
用来观察 agent 是否能恢复或解释残余状态。

## 新判据

Verifier 的输入是 trial、journey、leg、criterion、session、observation 和 workspace root。建议：

- 优先从隔离进程或 sidecar 读取产物，不信任 agent 自报“已完成”。
- 返回结构化 evidence；大制品只存摘要、路径、大小和哈希。
- 明确失败返回 `fail` + FailureClass；部分完成可用 `partial`。
- 验证器缺失、环境不可用或证据采集失败返回 `void`，不能伪装成 `fail` 或 0。
- 抛异常会被 runner 记录为 `verifier-failure`，只用于真正的 verifier bug。

## 新探测器

Detector 是同步纯函数，输入相同必须字节级等价。定义必须注明稳定 id、版本、观测面、运行相位、默认严重度与
是否允许运行期掐断。先写 synthetic hit/miss、累积快照去重和 archive/live 等价测试，再登记为 gating detector。

## Runtime 与 CLI

Runtime 模块导出工厂：

```ts
export async function createAgentLabRuntime() {
  return {
    detectors,
    verifiers,
    workspaceRoot,
    sourceCommit,
    consumerCommit,
    getJourney: (trial) => journeys.get(`${trial.journeyId}@${trial.journeyVersion}`),
    resolveDriver: (trial) => drivers.get(trial.executorId),
  }
}
```

先运行 `validate`，再用一条单 Journey 单 replicate job 做 smoke；确认归档 identity、unknown、工具去重和报告后，
才扩成多执行体矩阵。能力比较至少两个 Journey 簇；单簇结果只能诊断，不能宣称显著差异。
