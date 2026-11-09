# 调度与存储 owner 交接清理

接续 `59d61148`，继续使用 `codex/runtime-lifecycle-cleanup`；已发布基线仍是 main `70e93a2b` / v0.7.6 / 0.9.5。R1/E1 和未受影响的既有证明保留。本轮不合 main、不发版；原 D 工作树、用户空行和索引继续独立保护。

## 本批覆盖与独立差量

| 批次 | 审查链路与真实问题 | 修改与保留 |
| --- | --- | --- |
| R2 纠正 | RuntimeSession 的任务材料/trace → ComposedRuntime → 根绑定与 ModelToolRuntime 已验证归属 | 上批 CLOSED 是独立公开行为收紧，旧合同及三产品只读事实见 [合同核对](closed-session-history-contract-20261110.md)。改由 live Runtime 存储 owner 接纳/逐次核验/排空，保留 closed Session 的合法历史读取；不激活执行环境、不解析子 ID、不新增公共接口或兼容路径。 |
| A1：Agent 元数据 | AgentSupervisor start/resume/open/deliver，ActRunService request/inspect/answer | 返回 job 和宿主回调直接共享内部对象，观察方可改写调度身份、结果引用或待答请求身份。隔离这些身份数据，持久状态与实际控制仍唯一；不透明 detail 不新增深复制要求。原配额、父归属、取消、错误与交付收尾不变。 |
| S1：控制准入 | SessionControl.perform → binding.assertControl → 宿主 storage 回调 → close | 先调用端口再登记 pending，端口同步重入 close 可漏掉已受理读取。先登记延后执行的 Promise，再调用端口；沿用唯一 pending/closing，不新增状态机，不取消已受理的合法提交。 |
| C1：恢复释放 | ContextViewSession.acquireRecovery → end → metadata CAS | end 失败后 finally 清标记使重试伪成功；迟到旧回调还能结束同实例的新租约。失败保留重试身份，仅本代 lease 才 end，成功后只清本代 recovery 标记。保留 CAS 权威、到期身份、活着/未知进程保护和原始持久错误。 |

## 合同与设计

公开签名、模型操作、数值上限、依赖和版本不变。R2 纠正撤回未发布的 blanket CLOSED 行为，历史访问与执行 Session 关闭分属不同 owner；Runtime 关闭仍严格拒绝新读取并排空。独立控制 lease 尚无任务材料公共口，本轮不让产品解析私有归档标题、catch 或重开执行会话补接口。

A1 保证调度身份与回调/返回视图独立；opaque detail 的宿主值语义保留。C1 恢复回调可以在真实持久失败后重试，不能把失败清理当成功，也不能释放后续 owner。这些是现有 readonly/租约/关闭承诺的根修，不增加执行或授权能力。

Agent 旧实现的 start/resume 返回初始 job，后续交互、回答和终态以新对象替换 live.job，当前状态由 status/wait 查询；它并非实时变更的返回视图。本次复制不会使原实时视图过期。交互的 id/runId/kind/message 全部保留，answer 的原请求核验不变；不透明 detail 不参与回答、取消或去重身份判断，不因隔离请求外壳而增加深克隆限制。

## 验证与提交状态

已通过改动 lint、统一格式、Context→Agent→Velaros 各一次局部构建及三包顺序 2048 MiB 类型检查，module ownership 通过。19 个不同相关场景全部通过：A1 身份/交互 5 例，C1 恢复释放 3 例，S1 控制重入/关闭 2 例，R2 纠正的八条历史读取与一个已验证根归属用例共 9 例。本轮无失败项；原 R1/E1 及未变绿项不重跑，R2 被纠正的行为证明按新设计重验。

重验证只使用原共享锁，完成后正常释放；未跑全量/供应商/跨 OS 或旧发行矩阵。日志在本工作树 `.velaros-workspace/semantic-ownership-20261110/`，四批独立提交，仍不合 main、不发版。

下一组审查范围：运行事件重放、状态 inspect 与存储 owner 的交接，以及调度取消/结果交付失败归集；先核对真实调用链，不把未审范围写成既定缺陷。

| 独立批次 | 提交 | 定向场景 |
| --- | --- | --- |
| R2 owner 纠正 | `3529a98e` | 9 |
| A1 元数据 | 本批 `fix(agent): isolate scheduler and interaction identity views` | 5 |
| S1 控制准入 | 待提交 | 2 |
| C1 恢复释放 | 待提交 | 3 |
