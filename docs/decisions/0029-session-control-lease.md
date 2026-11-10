# ADR 0029 — 已有会话的存储控制 lease

日期：2026-11-09。状态：0.9.1 存储控制已固定；0.9.2 集中补齐只读追踪。旧冻结归档保持不变。

## 缺口与决定

宿主在会话空闲或应用重启后需要读取持久笔记、目标及按版本控制目标。`createRuntime/openSession` 要求真实执行口与完整模块绑定；为此重造浏览器等能力或读取私有绑定造伪模块，都违反资源与授权边界。

新增只持有存储的控制 lease，直接复用 SessionNotes、SessionGoal 及 RuntimeTrace。它不创建 Runtime、Kernel、Agent、Node、Host 或领域模块；没有 submit、execute、steer 或回答交互的权限。它适用于任意产品会话，不识别 workspace、People 或产品种类。

```ts
// @velaros-ai/velaros
openSessionControl(options: SessionControlOptions): Promise<SessionControlLease>

interface SessionControlOptions {
  readonly sessionId: string
  readonly storage: ContextStorage
  readonly binding: RuntimeSessionBinding
}

interface SessionControlLease {
  readonly id: string
  listNotes(input?: { after?: string; limit?: number }): Promise<{
    items: readonly WorkspaceEntry[]
    nextAfter: string | null
  }>
  readNote(input: RuntimeNoteRead): Promise<RuntimeNoteContent>
  getGoal(): Promise<GoalState | null>
  controlGoal(input: GoalControl): Promise<GoalState>
  trace(input?: ActTraceQuery): Promise<ActTracePage>
  traceBranches(): Promise<ActTracePage['branches']>
  close(): Promise<void>
}

// @velaros-ai/velaros/node，仅做 Node 环境身份解析，不建立执行资源。
resolveNodeRuntimeBinding(options: NodeRuntimeBindingOptions): Promise<RuntimeSessionBinding>
// NodeRuntimeBindingOptions: { cwd, binding, executable?, processConfinement? }
```

## 身份、授权和持久事实

宿主提供已核验的 executionIdentity/authorizationScope，必须与原 `createRuntime` 相同。对于 `createNodeRuntime` 的身份，先用 `/node` 的 resolveNodeRuntimeBinding 解析，参数与该 Node 装配的实际目录、可执行文件、显式本机策略相同；解析过程不创建 Host/runner。直接注入 Host 时，策略由宿主提供的不透明 authorizationScope 表达。

核心每次控制前核对原持久绑定完整性、身份及授权；不重新写绑定，也不把存储的私有模块目录交给产品造实现。原模块清单仍须是完整有效的绑定事实，控制 lease 不宣称它们当前已挂载。再次执行仍由正式 Runtime 核对全部真实模块 instance/generation。授权范围改变或旧 `runtime:workspace` 历史均拒绝 CONFLICT。

原笔记的 key/revision、分页、当前任务及历史重置水位保持。新 lease 里缺少笔记或目标控制对象统一 NOT_FOUND；已有 Runtime 方法的 MEMORY_NOT_FOUND 等错误语义不变。GoalControl.baseRevision、GOAL_CONFLICT 和状态机沿用 SessionGoal；resume 只修改目标事实，不恢复或启动模型运行。

会话尚不存在时可取得一个控制 lease：getGoal 返回 null、listNotes 返回空页，readNote/controlGoal 拒绝 NOT_FOUND；不创建会话元数据、输入或绑定。存在但缺绑定、绑定重复或损坏时拒绝，不把未知旧历史当成新会话。

0.9.2 的 trace 固定读取 lease.id 的根范围，每次重新核验上述绑定；query.sessionId 只能是该根或有持久归属记录的支线。traceBranches 仅返回当前任务支线目录，不加载请求或正文。不存在的根 trace 返回空页、目录为空，仍不创建元数据；跨根支线拒绝 PERMISSION。

两项追踪复用现有唯一 RuntimeTrace 与 Context 的只读 journal.list/read。ActTraceQuery 的模型请求/会话活动双游标、每页各最多 32 项、默认共享 maxChars 和八百万上限不变；显式 fullContent 只读已有归档正文并沿用分页，不重建或新归档完整模型请求。请求持久格式仍为有界 v3 元数据、指纹及真实发布帧引用，不复制图片。活动回合需重读，Context 快照与调用日志不宣称跨库原子一致。

成功打开后 lease 接管该次注入的存储连接；初始化失败仍归调用方。close 停止新准入，等待已受理读取或 CAS 操作落定，再关闭连接；重复关闭安全。产品仍负责同会话串行控制、删除/关闭排斥及其窗口权限检查，不能与活动 Runtime 共享并提前关闭同一个连接。

## 产品接入和版本门

Workbench 的 listNotes/readNote/getGoal/controlGoal：活跃时借现有 VelarosSession；空闲时通过上述存储 lease，finally close。它不需要上一轮 request、模型配置或领域实现。读取尚未运行会话时，产品可直接沿用其空页/null/不存在语义。

0.9.2 集中版本使用基础 `@velaros-ai/velaros@0.9.2` 和扩展 `@velaros-ai/capabilities@0.9.2`，扩展仍精确 required peer 基础 0.9.2；旧两包继续成对使用，不能把不同版本拼接。Bun 根 dependencies/overrides 使用同一固定基础资产来源。Desktop 的独立改动聚合 worker 与空闲调试只需本存储 lease，不恢复 dataDir/false 预设，也不装配空执行器。Workbench 已有调用无需额外合同。

以上记录 0.9.2 的历史安装方式。自 0.9.7 起，扩展通过普通必需依赖指向同 tag 的基础官方 URL；正式消费不使用 overrides/resolutions，组合根也直接声明同一精确 URL。根因与验证见 [普通依赖发行修正](../engineering/plain-dependency-release-20261110.md)。

宿主 UI peer 只属于能力扩展：Electron `>=41.0.0`、React `^19.0.0`、React 声明 `^19.0.0` 继承源码已声明支持范围和 optional 标记。0.9.0 发行器错误地把开发机版本写成精确 peer；0.9.1 修正发行投影，不扩写源码支持范围。基础 Node 包不声明这些 peer，普通第三方 dependencies 继续精确固定安装版本。

`sessions.tell` 没有新增核心缺口：现有能力只向宿主 SessionsSpacePort.tell 转发，合同要求活动 run 接纳 guidance 后返回 queued，空闲拒绝。产品完成成员与授权核验后取得已加载目标句柄并 `await target.steer(message)`；无活动时沿用 UNAVAILABLE，不回退 openSession/submit。Workbench 旧 tell→deliver→untilIdle→submit 的另开新轮行为应在产品 Host 迁移，不加入底座产品分支。

本轮只做一次受影响的真实 SQLite 控制/恢复/CAS 验收及独立 tarball JS/严格声明消费；领域扩展实现未改，比较新旧内容后复用已有业务验证。0.9.0 的 Linux 16 秒单轮已通过，产物 SHA 不变；模型协议未改，不重跑付费供应商或平台矩阵。新归档通过必要验证后一次交接，不覆盖旧候选目录。
