# Desktop 运行状态投影沉淀差量

日期：2026-09-22。将宿主按事件重复维护的回合、运行状态和输入回执收敛到既有 ActEventProjector。

## 公开数据合同

renderer 入口增加 ActRunPresentation 类型，ActPresentation.runs 使用该类型。原有 status、turnId、preview、messages、errors 保持，新增：

- turn：按唯一 turnId 计数的回合序号。
- failure：error 事件给出的失败原因，与可修复的协议 rejected 分开。
- queuedInputIds：已接纳且未消费的引导，以及明确保留的输入；显示身份去重。
- retainedInputIds：只来自明确的 input-retained，随后被消费的记录不再保留。

公开工厂和方法签名保持，provides/requires、工具定义、模型操作与 schema 没有变化。以上是只读投影数据扩展；手工构造完整快照的消费者需要补齐新增字段。

## 推导规则

输入消费按 sessionId + 归档 ref.id 区分，inputId 仅供宿主关联。同一宿主身份对应两份归档时，消费其中一份不能清除另一份待处理事实。重复接纳不能复活已消费记录，重复回合不能推进计数或回退当前预览。

主输入接受回执不进入引导队列，只有明确保留才进入待处理展示。取消、失败或 finish 都不从“尚未消费”推断“已确认保留”。不同 runId 的推导状态相互隔离；持久事件游标仍按原规则去重，实时事件不推进游标。

## Desktop 消费

ActivePlatformRun 保存投影器返回的当前快照，移除 turn/failure/terminal、guidance Set 和 retainedInputs Set。完成判断、usage 回合、状态查询和取消返回读取这份快照。Desktop 仍负责异步资源收束、产品消息身份及 IPC 映射；重复 turn/accepted 不再重复发送对应的界面边界事件。

交互的待回答清单及回答权限继续从实际 Runtime inspect/answer 获取，展示快照不能授权操作。

## 验收差量

新增 INV-44 和 6 个纯投影用例：实时/持久一致性、重复回合、归档身份与宿主身份、断流不推断保留、协议拒绝与运行错误区分、跨运行隔离及不可变快照。既有正文接纳与结束清理验收保持。

Desktop 新增同一宿主关联身份对应两份归档的回归，核对 queuedInputs、重复回合 UI 边界及取消 retainedInputIds；原真实 Runtime 与交付屏障集成用例继续执行。

## 验证结果

- Platform 投影及子运行回归 20 项通过；7 包拓扑构建通过。
- Desktop Runtime 与交付屏障集成 21 项通过，Electron Node 环境同样通过；21 个受影响类型分区通过。
- Desktop 生产构建与 Electron 入口产物校验通过。
- 两仓库模块归属检查、差量空白检查通过。
- Desktop 架构增量检查仍有既有的 6 项 document-renderer README 错误；该文件本轮未修改。

类型检查首次执行时本地链接包的声明产物不可解析；确认声明产物就绪后，按原有顺序分区命令复验通过。
