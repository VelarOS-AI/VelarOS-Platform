# Desktop 目标生命周期接入差量

日期：2026-09-22。

## 结果与职责

目标状态由 Platform 的 SessionGoal 保存在同一 ContextStorage 中，按版本 CAS 追加不可变记录。它跨运行、逻辑任务切换和 Runtime 重启保留，与单次执行状态、工作笔记驻留分开管理。Desktop 保留目标模式策略、历史数据适配、IPC 和目标卡片交互。

用户确定的行为：暂停目标后发送新消息仍保持暂停；点击继续或明确要求恢复后才恢复。目标模式首次发送先建立目标，再进入首个模型请求。活动目标不能仅凭 done 结束运行，模型须继续推进，或显式记录完成依据、阻碍等状态；执行预算仍有界，取消、失败与预算耗尽都不自动改写目标状态。

## 公开合同与模型操作

- `VelarosSession.getGoal/updateGoal/controlGoal`：宿主读取、版本化更新、用户生命周期控制。`controlGoal` 独有 remove；删除保存墓碑，版本不归零，防止历史目标再次出现。关闭后拒绝新操作并等待在途访问。
- 数据合同 `GoalState`、`GoalStatus`、`GoalUpdate`、`GoalControl` 从 Runtime 根入口和 contracts 导出。目标有独立 id、revision、objective、status、reason 和时间；新目标生成新 id，revision 继续递增。
- `GoalHost` 是 system 的注入合同，解析实际调用会话的目标账本。主会话装配 goal 成员；搜索、整理和业务子任务不获得主会话目标控制。
- 新增 `goal.get`：无外部效果的当前目标读取，含 revision 和删除墓碑。
- 新增 `goal.update`：execute 写操作，必须带 baseRevision；新建有内容上限，完成或受阻要求 reason。状态包括 active、paused、complete、blocked、cancelled。省略 status 沿用已有状态；活动与暂停目标不能被另一目标覆盖。
- SystemContract revision 从 20 到 21。GoalModule 提供真实 schema、声明、效果、发现和模板；Act 清单由生成器更新。
- 新增 Runtime INV-48、System INV-19。

## Desktop 接入与清理

- 目标操作复用会话控制队列；活动运行直接操作同一 Runtime，非恢复操作先完成 CAS 写入再停止运行。旧版本点击不会停止当前运行。空闲时使用无模型 Runtime，核验既有工作区绑定。
- Goal IPC 增加必填 baseRevision，并将读取和更新从历史低风险登记移入高风险来源校验名单。renderer 传递其读取的目标版本，冲突后沿现有目标卡片刷新路径重新读取。
- 目标卡片的已有展示合同由 PlatformGoal 适配；运行状态与回合变化、用户操作响应触发刷新。
- 历史目标读取使用零版本；首次操作或推进时写入 Platform，保留状态和目标正文，同时存储迁移审计。历史原数据保留。墓碑优先于历史回退，移除目标不会再次迁入。
- Service 移除无法到达的旧目标 upsert 与旧生命周期修改 helper 调用。通用 contextGovernance 仍仅代表其已接入能力；外部引擎的目标操作保持明确不可用。

## 验收变动说明

System INV-3 的发现操作总数由 22 调整为 24，新增的两项正是 goal.get/update。根目录测试只输出其需要检查的成员与模板，避免完整声明对象超过脚本输出预算；仍验证完整目录成员、操作总数、memory 模板、根模板和 goal 操作。通用模板验证器增加 goal 的聚合成员映射，继续检查所有实际操作、schema 声明与模板一致。

## 边界

运行预算保持现有 Platform 约束，不自动派生后台无限续跑。模型明确完成表示其提供了完成依据，业务结果仍需实际证据和现有运行验收。当前目标卡片沿用已有显示结构；目标历史浏览、目标步骤的结构化编辑和整段历史上下文归档继续独立整理。

## 验证结果

- Platform 目标、工作笔记、任务生命周期、系统装配与系统验收共 34 项通过。目录验收更新后，其所在的 24 项系统测试全部重跑通过。
- Desktop Electron Node 集成 24 项通过，覆盖首帧目标、普通停止、活动执行中暂停、暂停后新消息、明确恢复、模型完成、重启、历史迁移和墓碑防复活；过期操作不会取消活动执行。
- IPC 参数与发送方校验 15 项通过；230 条请求分级检查通过，来源豁免为零。
- Desktop 21 个受影响类型分区及分区登记门禁通过，IPC 包构建、生产主程序构建和 Electron 入口产物检查通过。
- 两仓库模块所有权检查、Act 清单生成与漂移检查、git diff --check 通过。
- Desktop 增量架构检查仍报告 document-renderer README 的 6 项既有错误。本轮未进行图形界面手动点击验收，也未验证干净环境依赖重装。
