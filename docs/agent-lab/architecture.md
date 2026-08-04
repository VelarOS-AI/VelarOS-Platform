# Agent Lab 产品架构与不变量

## 主路径

```text
真实用户 / 计划 / hook 任务
        │
生产执行账本 + 会话 + 产物 + 用户反馈
        │  宿主归一化
        ▼
RealTaskRecord ── deterministic audit ── assessment + private-safe HTML
        │
        └─ 人工审阅 prompt + workspace snapshot + acceptance
                            │
                            ▼
                     RealTaskCase ── explicit replay ── Journey archive
```

Agent Lab 不自动发任务。审计路径是纯计算与本地 I/O，零模型调用；复跑路径必须由宿主的显式命令触发，
默认一次、一个执行体、串行。

## 模块职责

| 模块 | 唯一职责 | I/O 权限 |
| --- | --- | --- |
| workload | 真实任务 schema、结果/健康审计、案例固化、隐私安全报告 | 纯函数 |
| archive | 真实任务 bundle、案例、Journey 归档的原子文件 I/O | 文件系统 |
| protocol | 显式复跑/实验的 Journey 数据语言 | 纯函数 |
| detect | 复跑期间的确定性健康探测 | 纯函数 |
| runner | 单案例或明确研究矩阵的预算、调度、verifier 调用 | Driver / Verifier |
| drivers | 执行体原生生命周期与收敛语义 | 产品控制面 |
| report/statistics/certification | 复跑/研究归档的展示与保守统计 | 纯函数 |

架构门禁止纯模块导入 Node I/O、网络或 Electron，也禁止包依赖其他 VelarOS 产品包。

## 不变量

1. Agent 自报完成不是验收；没有独立 evidence 时 `outcome=unknown`。
2. 任务结果与执行健康分开。正确结果不能抹掉工具错误、冗余调用、顺序重试或系统故障。
3. span、断言、产物和用户反馈保持 provenance；缺席永远不补成 0、false 或 pass。
4. 并行发起的同类失败与看到反馈后的顺序重试分开分类。
5. 报告不包含 prompt、回答、绝对路径和产物正文；固化案例必须人工审阅隐私。
6. 问题固化必须有 prompt、可定位的隔离工作区引用和至少一条确定性验收契约。
7. 复跑不自动重复；比较执行体或统计重复次数必须是明确批准的研究动作。
8. 历史 Journey 归档只读。固定产品 suite 退役不等于删除实验数据。
9. 外部执行体保留原生工具、提示、审批和收敛行为；缺少模型/usage 观测就明确记 gap。
10. 生产执行观测是旁路：记录失败不能打断任务主链。
