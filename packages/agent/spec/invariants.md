# Act 不变量

旧合同迁移理由见 `docs/engineering/agent-test-migration.md`；编号延续已有登记。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-16 | 可移植合同入口不加载 Node | 门禁 | `check:agent-browser` |
| INV-18 | 实现、注入、数据和公开面归属唯一 | 门禁 | `check:module-ownership` |
| INV-19 | 公开破坏性变更需要主版本和基线 | 门禁 | `check:agent-public-api` |
| INV-29 | 不响应取消的驱动不能无限阻塞循环 | 测试 | `spec/acceptance.test.ts` |
| INV-30 | 并发额度在派发前占位；子任务不占写入范围 | 测试 | `spec/acceptance.test.ts` |
| INV-31 | 子任务身份和配额可重启恢复 | 测试 | `spec/acceptance.test.ts` |
| INV-32 | 父取消传播并保留部分结果 | 测试 | `spec/acceptance.test.ts` |
| INV-33 | 并发失败不覆盖已完成任务的事实 | 测试 | `spec/acceptance.test.ts` |
| INV-34 | 一个收尾阶段失败仍尝试其余阶段，完成事件等待收尾成功 | 测试 | `spec/acceptance.test.ts` |
| INV-35 | 接受事件不能持久化时不派发脚本 | 测试 | `spec/acceptance.test.ts` |
| INV-36 | 子结果落盘故障必须传给父等待者 | 测试 | `spec/acceptance.test.ts` |
| INV-37 | 新输入从到达时抢占旧响应，轮边界等待输入持久化 | 测试 | `spec/acceptance.test.ts` |
| INV-38 | 子任务交付内嵌事件有界并声明省略量；需要核对的状态不能变成普通完成 | 测试 | `spec/acceptance.test.ts` |

| INV-39 | 输入接纳与消费分别持久化并带宿主身份；消费绑定具体请求，取消保留未消费输入，重启后只消费一次，回执写入失败不派发模型 | 测试 | `spec/acceptance.test.ts` |

| INV-40 | 容量规划按供应商实测用量校准估算（带图请求不取样、超窗拒绝后回到原始估算），按同段同底座的正向增长估计剩余轮数；两次封段过近记为抖动，同一段的整理只跑一次 | 测试 | `test/context-planner.test.ts` |
| INV-41 | 每小时模型用量到上限时发 throttled 并等待后继续；用户总上限到了以 waiting 暂停，输入保留给下一次运行 | 测试 | `spec/acceptance.test.ts` |
| INV-42 | 一段里缺页持续偏高按结构性超载处理：同一段只跑一次压力整理，ContextStatus 给出收紧工作集的建议 | 测试 | `spec/acceptance.test.ts` |
| INV-43 | 模型的思考摘要作为 reasoning 事件跟在所属 turn 之后交给宿主，只作展示：不进上下文、不落事件账 | 测试 | `spec/acceptance.test.ts` |
