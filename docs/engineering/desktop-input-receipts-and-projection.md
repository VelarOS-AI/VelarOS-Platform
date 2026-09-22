# Desktop 输入回执与展示投影沉淀差量

日期：2026-09-22。范围是当前 Act 输入事实与展示投影；工作基于已有本地架构重组，保留其他改动。

## 对外契约

- agent `contract/act.ts`：ActInput 增加可选 inputId；input 事件增加可选 inputId/source；新增 input-applied（ref、inputId、turnId）与 input-retained（ref、inputId）。source 可选用于读取既有归档。inputId 是关联标识，不是去重键。
- agent `contract/provides.ts` 登记的 ActRunServiceApi：明确 submit 的接纳、消费和保留回执语义，方法签名不变。
- agent `contract/requires.ts`：ActLoopControl 增加可选 applied(turnId, signal)，由唯一 ActRunService 装配；轮边界冻结本次待消费输入，请求归档后才提交消费回执。
- velaros `ActEventProjectorApi`：增加 applyLive 与 finish；现有 apply、snapshot 保持。产品接口仍登记在 runtime/contract/provides.ts，从已有 renderer 入口提供。实时流不推进持久游标，正文按回合去重，跨会话/运行信封身份检查保留。
- 工具定义和工具合同没有变化。

## 运行行为

主输入在取得任务运行权后发出持久接纳事实。追加引导保持原先抢占语义，输入进入哪个已归档模型请求由 applied 回执指明；这不代表 provider 已收到请求。结束时等待并排空输入落盘，交出仍未消费的身份，然后发出终态。重启根据接纳与消费记录恢复待处理输入，同时识别原有消费审计标记。

投影器统一处理实时/持久正文；取消、失败、容量阻塞、待核对、完成和宿主交付结束会清除预览。已接纳正文不会被重复接纳或迟到文本复制或覆盖。

## Desktop 消费

Desktop 的 messageId 原样成为 inputId；准入使用主输入接纳回执，追加引导消费使用 applied 回执，取消保留身份使用 retained 回执。投影器在主进程处理 Platform 事件，renderer 接收完整预览快照并直接替换，不再自行累积文本增量。IPC、窗口、产品转录与设置装配仍由 Desktop 持有。

## 验收差量

Platform 原有验收断言保留，新增输入身份/请求关联、取消与重启、重叠引导、接纳与消费写入故障，以及预览清理、正式正文去重的回归。Desktop 原有文本增量 fixture 改为完整快照，保留正式接纳、拒绝、恢复和幂等的原始行为承诺；新增“turn 不是输入消费回执”的定向用例。

## 版本与兼容

Agent 公开 API 门要求契约变化绑定新包版本，因此包版本从 6.1.0 更新为 6.2.0，并按 additive 审核更新声明基线：inputId/source 与 applied 注入口均可选，原方法保持；事件新增两种回执，宿主的穷尽事件匹配需要加入对应分支。仅更新本地清单和基线，发布仍沿正常发布流程执行。

## 验证结果

- Agent 验收 22 项、Runtime 会话与投影 23 项通过。
- Desktop 真实 Platform 集成 12 项、renderer/取消/ESM 边界 17 项通过；21 个受影响类型分区通过。
- 7 个依赖包拓扑构建通过；Desktop 生产构建及 Electron 入口产物校验通过。
- 两仓 module ownership、Agent 公开 API 和浏览器边界、锁文件一致性及包目录清单检查通过。
- Desktop 架构差量门仍有 document-renderer README 的六项既有错误，文件未在本轮修改。

Agent 的 workspace 版本已在 bun.lock 与清单对齐，包目录清单同步生成。既有并行架构重组和 Desktop 主链路改动均保留。
