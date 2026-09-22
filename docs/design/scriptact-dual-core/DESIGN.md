# Platform ScriptAct 双核正式实现

> 历史设计与阶段验收记录。本文中的接口、路径和测试数字对应其记录阶段；当前实现请读 [Act 运行架构](../../architecture/platform-runtime.md)、[模块规范](../../architecture/module-ownership.md)、[系统能力](../../architecture/act-system-space.md) 与 [存储合同](../../architecture/storage.md)。原始输入规格保存在 reference-pack/。

平台全局结构与当前接入方式见 [统一执行架构](../../architecture/platform-runtime.md)。

状态：实现于现有 Platform 主干。本文定义本仓库的装配方式和实际保证；`reference-pack/` 保留输入规格。验收记录见 `validation.md`，接入位置见 `implementation-map.md`。

## 核心模型

主核决定目标、下一步操作与观察需求；上下文核选择有限候选；Runtime 读取并发布真实证据。只有主核能够通过 `script.run` 执行业务能力。上下文核拿到候选数据和一个 `context.plan` 结构化提交口。

一次工作步的顺序固定为：

1. 用户目标进入原始记录；任务通过持久化 CAS 取得有限租约。
2. ProviderRequestCompiler 编译完整模型请求，核对协议、指纹、输入窗口和输出预留。
3. 主模型提交一段 JS；现有 KernelScriptSession 检查并交给 QuickJS 执行。
4. 每次能力调用先持久化意图，再派发，再保存真实回执。脚本可登记观察需求和更新任务胶囊。
5. Runtime 从 Kernel 日志结算本步，包括脚本捕获的错误、部分成功与不明效果。
6. 精确需求直接解析。语义需求在需要时调用有界规划器。
7. Materializer 从实际 Source 重读、核对授权和版本，保存证据正文，再 CAS 发布 ModelView。
8. 下一轮编译前再次校验视图。模型最终文本经过完成检查，验收状态单独报告。

世界效果、任务检查点、下一轮 ModelView 是三个不同对象。重建视图只执行读取。

## 依赖方向

```text
Velaros 装配 → Agent 主循环 / Context / Script / Kernel / Model 适配器
Agent → Context + Kernel 中立模型协议
Model → Kernel 中立模型协议，提供供应商实现
Context → Kernel 调用数据，依赖宿主注入的 Storage / Source
Script → Kernel 能力调用，依赖显式隔离执行器
Project Source → 已有项目内核
```

`ModelDriver`、中立请求数据与文本编码器由 Kernel 定义；ProviderRequestCompiler 仍在 Agent，主核与上下文核共用它。Model 的 AI SDK 驱动只负责供应商转换，不选择证据。此依赖图通过 Agent/Kernel/Model 架构门禁，不增加基线豁免。

## 包内职责

| 所属包 | 正式职责 |
| --- | --- |
| Kernel | 中立模型协议、模块 schema/发现、实例绑定、调用身份、派发前提、持久化调用契约、只读核对入口 |
| Script | JS 检查、虚拟模块导入、QuickJS/IPC 执行、操作数量和输出边界、取消 |
| Context | 原始记录、对象存储、任务 CAS、ViewIntent、候选校验、证据物化、派生来源、视图发布、预算与完成状态 |
| Agent | 主循环、有界 Context Planner、两角色请求编译、窗口预算、主运行期限、状态事件 |
| Velaros | 同一对象图的装配、标准脚本模块、按执行收集真实回执、模式配置、会话恢复 |
| Velaros Project | 通过原项目内核读取/搜索/符号定位，继承路径、编码、revision 与事务检查 |

目录沿用各包的 interface/contract/impl/utils 或现有 contract/types 分层。没有新建 Runtime 包或数据库。

## 模型可见的简单入口

外部模型工具保持 `script.run({ source, input?, blobs? })`。脚本可使用：

| 模块 | 操作 | 用途 |
| --- | --- | --- |
| `modules` | list / search / describe / release | 发现宿主实际挂载的领域模块，说明、schema 和执行登记同源 |
| `view` | sources / request | 查看只读源能力，声明下一轮需要的证据 |
| `task` | inspect / update | 查看阶段与预算；维护下一目标、假设、决策、问题 |
| `artifacts` | put / read | 持久保存大材料、分页读取本任务的引用 |
| `execution` | inspect | 查询某次操作的真实意图和回执 |
| `context` | inspect / search / read / write / replace | 原始材料召回与传统工作集处理 |

```js
import { view, task, artifacts, output } from 'velaros';
const sources = await view.sources({});
await task.update({ nextObjective: '核对修改后的函数' });
await view.request({
  kind: 'direct',
  target: {
    kind: 'resource', sourceId: sources[0].id,
    resourceId: 'src/auth.ts', selector: { kind: 'symbol', name: 'authenticate' }
  },
  importance: 'required', forms: ['definition', 'excerpt']
});
output('已登记下一轮观察需求');
```

登记返回 Runtime 签发的需求 ID；本轮脚本不获得模型生成的“观察结论”。业务操作继续从其真实模块导入。脚本局部变量只属于本次执行；跨轮数据使用 Artifact 引用。

## 三个契约

**ViewIntent** 表示需求。精确目标是 Source/resource/selector 或本任务 Artifact；语义需求是 objective 与可选 anchors。重要性、允许的表示、时间语义都是有界请求，不能改变权限或硬预算。

**ContextPlan** 表示候选选择。候选 ID、允许的表示和关联 intent 由 Runtime 登记。规划器只能选择、检索、检查或报告不足。未知候选、跨需求引用、重复选择、未允许的表示会被拒绝并消耗有限修复机会。计划不携带事实正文。

**ModelView** 是实际下一轮材料。它包含完整受保护用户目标、任务胶囊、真实回执、当前脚本及输出的有界片段和恢复引用、真实证据、覆盖状态、缺口、读集、一致性标记与计量。模型笔记标为 model-derived，源文本标为 source-data。两个模型步骤读取同一 ContextTaskFrame 和任务账本，Runtime 按每一步的需求构造实际材料。

来源撤销、版本变化或正文指纹错误会使视图失效。摘要引用的证据读集沿 Artifact 传播；源变更后，摘要不能以当前证据发布。证据被预算淘汰时，覆盖状态同时变为 partial/missing。

## 状态与副作用

任务检查点跟随既有 ContextStorage 状态一次 CAS 提交。任务 revision、执行 ID、有限 lease 保护物化发布与写入前提。检查点保存用户目标、胶囊、需求、操作反馈、Artifact 引用、视图、用量和验收状态。

状态主线是 ready → executing → context-pending → view-ready。未知效果进入 needs-reconcile。完成、取消、失败及 context-blocked 均是可观察状态；新的用户输入开启下一次推进。取消后迟到的操作可以继续形成审计事实，但不能复活任务。

操作 ID 与原请求指纹绑定。同 ID 不同参数返回 IDEMPOTENCY_CONFLICT。持久化意图存在而终态缺失时不能重新派发。多操作脚本的部分成功分别记账，脚本失败不能覆盖已提交效果。

`session.reconcile()` 由宿主发起，调用原模块实例的只读 `OperationDefinition.reconcile`。模块检查外部幂等记录、事务或资源状态；没有足够证据返回 null。核对结论作为追加事实持久化，保留原始回执。没有核对器时保持未决。

发布前验证不等于世界事务。Project 的条件写继续复用 revision、原文及其事务机制。任务在业务写入派发前检查未决效果、required 缺口及先前证据是否仍有效；每个领域继续负责具体原子性。Project Source 的能力声明为 revision 可核对、条件写 best-effort，不宣称跨进程原子事务。

## 容量、失败与完成

默认每次物化最多 16 个需求、32 个候选、2 次上下文模型调用、6 次检索/检查动作、64 KiB 检查正文、24,000 字符证据和 2 次版本重取。物化有 30 秒期限，任务 lease 默认 6 分钟。主核与上下文核共享 128 次模型调用、500,000 token 预留预算；宿主可以显式配置。

最终模型容量由 ProviderRequestCompiler 使用驱动对实际传输请求的估算决定，包含协议、schema、输出和安全预留。Materializer 先限制证据大小；发送门不再修改已发布事实字节。强制区放不下则 context-blocked。供应商未报告用量时记录 unmeasuredCalls，不能记成实际 0 成本。

脚本类型错误、外部入口 schema 错误、缺失 ViewIntent 和脚本提前失败仍产生可见反馈。驱动或 Source 未及时响应 AbortSignal 时，等待边界也会结束；迟到结果不能发布。

final 是完成请求。未知效果、required 缺口和过期读集阻止完成。有领域验收器时，在验证前后核对当前读集；没有验收器，输出明确的 unverified 状态，不把模型自报当作测试通过。

## 一致性和表示

| Source 能力 | 发布语义 |
| --- | --- |
| snapshot | 明确的快照标识，源必须实际支持 |
| revision-checkable | 读取版本可复核，标为 validated-as-of |
| observed-only | 标为 observed-at，不伪造强 revision |

当前 Project Source 读取工作区当前状态；历史正文通过既有不可变材料引用恢复。符号与行范围复用项目内核。非 UTF-8 文本由原编码层处理；二进制正文返回明确缺口，由对应领域适配器负责。

diff 当前只作为可选表示请求：没有本次请求内的可重构基线时使用允许的原文/切片，或返回 BASELINE_MISSING。不会凭“上一轮看过”给差量正文签发当前完整覆盖。

## 宿主装配

```ts
import { createRuntime } from '@velaros-ai/velaros'
import { createProjectContextSource } from '@velaros-ai/velaros/project'
import { localContextStorage } from '@velaros-ai/context/node'
import { createAiSdkModelDriver } from '@velaros-ai/model'

const runtime = createRuntime({
  storage: localContextStorage({ path: absoluteStateFile }),
  runner: approvedScriptRunner,
  modules: mountedOperationModules,
  model: createAiSdkModelDriver({ id: mainModelId, model: mainProviderModel, limits: mainWindow }),
  context: {
    mode: 'active', strategy: 'dual-core',
    sources: [createProjectContextSource({ id: 'project', kernel: projectKernel })],
    // model: 可选的另一供应商配置；省略时复用主模型配置，两者共享任务帧。
    // completion: 领域提供的真实验收器。
  },
})
for await (const event of (await runtime.openSession(sessionId)).submit(userText)) {
  // 消费 text / state / usage / verification / error。
}
```

宿主直接调用 `session.run` 时，先通过 `session.context.append({kind:'user',body})` 登记目标。会话关闭会释放 lease；中断恢复先看检查点与操作日志，存在未决效果时调用宿主核对入口。

配置缺省为 off，便于已有宿主逐项迁移。shadow 使用原发送方式，只记录观察元数据，不额外读世界或调用上下文模型。active 使用当前物化视图。策略 append-history / model-output / direct / dual-core 仅改变上下文选择，世界执行和完成检查同源；它们用于后续同任务评测。

普通计量读取 `session.view.inspect()` 中的 usage、metrics、status、verification，再只导出所需数值字段。原始审计保存在会话存储，包含敏感业务原文，不能直接作为普通公开 trace。来源发布权限由宿主实际 Source/空间规则决定。

## 验证与发布边界

仓库自动化已覆盖主干机制、实际 QuickJS、SQLite 重启、真正进程退出后的核对、AI SDK 传输形状及受限模型响应。真实供应商的任务质量、价格、缓存收益和多模型成本对照需要单独运行，当前没有付费模型实测结论。

本地 Script 运行器的既有发布认证标记仍为 false；生产宿主须使用通过部署环境认证的执行器。平台的双核机制是正式代码路径，是否发布该执行器由原发布门独立决定。
