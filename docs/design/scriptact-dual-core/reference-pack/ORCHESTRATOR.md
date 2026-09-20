# 编排器参考控制流

以下为职责级伪代码，不是可运行实现。应映射到现有任务状态机、存储和 provider adapter，而不是照抄未定义函数名。

```text
runTask(taskId):
  取得当前任务唯一执行 lease
  从 checkpoint 恢复任务与操作账本
  若存在未知外部副作用:
    暂停并 reconcile；不要重放脚本

  view = 已发布且仍有效的视图，或 bootstrap(task)

  while task 非终态且预算允许:
    检查 lease、taskRevision、policyVersion
    若用户目标或权限变化，重新构造 view

    decision = MainModelPort.decide(view)
    记录模型使用量和原始结构化决策

    若 decision 为 need_user:
      保存问题与阻塞原因，暂停

    若 decision 为 final:
      检查未结算操作、required 缺口与验证证据版本
      有明确阻塞则生成 mandatory feedback 并继续/暂停
      否则保存带验证状态的结果，进入 completed

    否则:
      校验 script 大小、模块、协议和安全执行设施
      创建 step 和 step lease
      持久化待执行模型决策

      try:
        report = ScriptExecutorPort.execute(script)
        # 每个能力调用已由 Broker 独立记录 prepared/dispatched/settled
      catch executor crash/timeout:
        report = 从操作账本重建，而不是假定什么都没发生

      撤销本步新增能力调用权限，结算已发起操作
      保存 report 与非事实性质的任务 handoff

      若出现 unknown 外部副作用:
        needs-reconcile；暂停依赖该结果的流程
      若出现待审批调用:
        awaiting-approval；保存输入 hash 与具体 operation
      若已取消:
        cancelled；迟到结果仅进审计，不复活任务

      barrier = effects-settled journal sequence
      intents = 本步登记且仍合法的请求
      mandatory = 从 report、任务约束、缺口和系统事件确定生成
      # 即使 intents 为空，也不能省略 mandatory

      directPlan = DirectResolver.resolve(精确需求)
      candidates = 现有索引和适配器返回的授权候选
      若仍有语义缺口且 planner 预算允许:
        contextPlan = BoundedContextPlanner 决策/有限展开
      否则:
        contextPlan = directPlan + 固定检索选择 + 明确缺口

      对 contextPlan 做 schema、ID、scope、配额与表示形式校验
      materialized = Materializer 读取真实源并构造证据
      验证 readSet；必要时局部重取，最多指定次数
      对最终裁剪后内容重新计算 coverage 和 required 缺口
      compiler = 现有 ProviderRequestCompiler
      finalRequest = compiler 保持消息合法性、信任区、预算与安全门禁

      若无法安全发布:
        保存 context-blocked 原因，暂停
      否则:
        在元数据事务中保存 view、readSet、检查点与发布记录
        view = 新 ModelView
        # Context 阶段重试绝不重新执行本步世界操作

  预算耗尽时明确暂停/失败，不静默宣称任务完成
  释放执行 lease
```

## 两个故障边界

世界操作发生后 Context Planner 崩溃，只重试上下文阶段。没有收到工具回执不等于工具没有执行；遇到未知外部副作用必须核对真实状态。

## 性能优化次序

先实现串行正确流程，再做 direct fast path、源版本缓存、稳定前缀与候选复用。最后才评估只读并行和较小上下文模型。不要在没有一致性测试时并行运行主核写操作与其下一轮证据物化。
