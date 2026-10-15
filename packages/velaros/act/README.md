# Act 能力目录

<!-- 由 scripts/script/act-catalog.mjs 从 surfaces.mjs 的登记与生成的模型面写出，不要手改。 -->

当前共 20 种合同投影、104 个投影操作、62 项去重后的用法。系统包 `velaros:system` 有 7 个成员（modules、environment、programs、executions、goal、memory、store），每个成员按宿主装配与会话授权挂上其中一种投影；实际可用项由宿主配置、会话作用域和当前授权决定。

| 目录 | 模型操作 | 可用条件 | 使用模板 |
| --- | --- | --- | --- |
| [runtime/ — completion-validation](runtime/README.md) | `execute` | 完成复核作用域，在本次固定文件副本上执行有界断言 | [completion-validation-template.js](runtime/completion-validation-template.js) |
| [runtime/ — completion-evidence](runtime/README.md) | `retrieve` | 完成复核作用域，生成合同绑定原生只读接收门 | [completion-evidence-template.js](runtime/completion-evidence-template.js) |
| [system/ — system-environment](system/README.md) | `list`、`search`、`describe`、`apply`、`rollback` | 宿主绑定持久 npm 环境，沿用会话权限 | [environment-template.js](system/environment-template.js) |
| [system/ — system-goal](system/README.md) | `get`、`update` | 主会话 | [goal-template.js](system/goal-template.js) |
| [system/ — system-memory-local](system/README.md) | `list`、`read`、`update`、`plan`、`retain`、`release` | 搜索或未启用整理的会话 | [memory-local-template.js](system/memory-local-template.js) |
| [system/ — system-memory](system/README.md) | `list`、`read`、`update`、`plan`、`retain`、`release`、`organize` | 具备整理模型的主线或业务子任务 | [memory-template.js](system/memory-template.js) |
| [system/ — system-memory-persistent-local](system/README.md) | `recall`、`save`、`remove`、`list`、`read`、`update`、`plan`、`retain`、`release` | 主线宿主配置 memory，没有整理模型 | [memory-local-template.js](system/memory-local-template.js) + [memory-long-term-template.js](system/memory-long-term-template.js) |
| [system/ — system-memory-persistent](system/README.md) | `recall`、`save`、`remove`、`list`、`read`、`update`、`plan`、`retain`、`release`、`organize` | 主线宿主配置 memory，且具备整理模型 | [memory-template.js](system/memory-template.js) + [memory-long-term-template.js](system/memory-long-term-template.js) |
| [system/ — system-store](system/README.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`watch`、`publish`、`share`、`set`、`remove`、`create` | 获配创建空间能力 | [store-template.js](system/store-template.js) |
| [system/ — system-store-write](system/README.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`watch`、`publish`、`share`、`set`、`remove` | 获配空间写入范围 | [store-write-template.js](system/store-write-template.js) |
| [system/ — system-store-read](system/README.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`watch` | 共享空间只读授权 | [store-read-template.js](system/store-read-template.js) |
| [system/ — modules](system/README.md) | `list`、`search`、`describe` | 默认装配 | [modules-template.js](system/modules-template.js) |
| [system/ — executions](system/README.md) | `read`、`wait`、`stop` | 当前任务的执行观测与定向停止 | [executions-template.js](system/executions-template.js) |
| [system/ — programs](system/README.md) | `publish`、`list`、`describe` | 具备当前会话程序目录 | [programs-template.js](system/programs-template.js) |
| [system/ — context-materials](system/README.md) | `list`、`read`、`submit` | 整理作用域 | [context-materials-template.js](system/context-materials-template.js) |
| [agents/ — interaction](agents/README.md) | `ask`、`confirm` | 默认装配 | [interaction-template.js](agents/interaction-template.js) |
| [agents/ — widget](agents/README.md) | `show` | 宿主配置 widgets | [widget-template.js](agents/widget-template.js) |
| [agents/ — agents](agents/README.md) | `profiles`、`start`、`resume`、`reply`、`status`、`wait`、`waitAny`、`cancel`、`send` | 宿主配置 agents | [template.js](agents/template.js) |
| [search/ — search](search/README.md) | `profiles`、`search`、`read` | 宿主配置 search | [template.js](search/template.js) |
| [search/ — evidence](search/README.md) | `query`、`read`、`report` | 搜索作用域 | [evidence-template.js](search/evidence-template.js) |

共享会话、协议解析、程序版本、结果租约与五分区组装位于 [runtime/](runtime/README.md)。搜索执行与预算在 [search/](search/README.md)。

模型面只有一个来源：各组 `impl/*Operations.ts` 里的操作接口——方法上的 `@AgentView` 说明、`@OperationEffect` 效果与 `@OperationModes` 入口，加上入参与回执类型及其注释。`bun run generate:script` 由它写出各组的 `contract/surface.ts`（给模型的声明、由类型派生的 schema）与 `baselines/script/` 下的同一份声明；`impl/*Module.ts` 只把生成的模型面接到会话端口上，取值上限由实现自己核对。模板位于组目录。

模型使用示例：

```js
import { output } from 'velaros';
import { modules } from 'velaros:system';
const usage = await modules.describe({ module: 'velaros:system', exports: ['memory'], template: true });
output(usage.template, { type: 'code' }); // 按需读取模型用法；精确参数见 usage.declarations
```

模型从 `velaros:system` 导入自管理成员。宿主的 `@velaros-ai/velaros/act/system` 入口提供装配实例和端口类型；[系统入口模板](system/template.js) 展示基本使用。

| 操作 | 允许入口 | 声明效果 | 用途 |
| --- | --- | --- | --- |
| `velaros:completion-validation.execute` | `execute` | `write` | 本次复核最多两次。通过 JSON.parse(process.env.VELAR_REVIEW_INPUTS) 取得所选身份对应的只读文件 URL，再 import 或读取。仅临时工作目录可写；网络、子进程和副本外文件不可用，依赖须在所选文件中。回执只证明本次断言；区分产品反例、断言错误和环境缺口。 |
| `velaros:completion-evidence.retrieve` | `observe`、`execute` | `none` | 一次查询 1..16 项；read.limit 为 1..32000，find.literal 为 1..256 字符，find.limit 为 1..16。一次复核最多 4 批、64 项、131072 正文字节，每批最多 32768 字节；原文读取上限 16777216 字节。按 nextOffset 续读，issue 是缺口；目录元数据不能证明正文正确。 |
| `system.environment.list` | `observe`、`execute` | `none` | 查看当前版本、直接安装的包和保留的回滚版本；最多直接安装 128 个包，保留最近 16 次发布。 |
| `system.environment.search` | `observe`、`execute` | `none` | 搜索 npm 包，query 最多 256 字符，limit 默认 10、最多 20。第三方说明作为资料读取。 |
| `system.environment.describe` | `observe`、`execute` | `none` | 查询包名、版本、Node 要求和依赖。package 最多 256 字符；最多返回 20 个版本，超出时缩小版本范围。 |
| `system.environment.apply` | `execute` | `write` | 按 list 的 baseRevision 安装、升级、替换或卸载，install 和 remove 各最多 32 项，规格最多 256 字符，删除包名最多 214 字符。支持 registry 包、版本范围、标签与 npm alias。allowScripts 默认 false，需要构建时可显式开启，仍经宿主权限检查。发布完成后下一次执行自动使用新版本；失败保留原环境。 |
| `system.environment.rollback` | `execute` | `write` | 将 list.history 中的 revision 发布成新版本，baseRevision 必须是当前版本。下一次执行生效。 |
| `system.goal.get` | `observe`、`execute` | `none` | 读当前目标的完整正文与状态：从未建立过时是 null，用户删掉的目标以 removed 状态的墓碑返回。 工作帧里的 objectiveInRecord、reasonInRecord 是原文引用，不代表正文已读；可按其中的 ref、pointer 用 memory.read 分页读取。 |
| `system.goal.update` | `execute` | `write` | 建立、暂停、恢复或结束目标；先 get 拿到 revision，版本变了就重新读取再改。 |
| `system.memory.list` | `observe`、`execute` | `none` | 按种类与标题分页查当前任务的材料：只有引用、位置、大小与笔记版本。 |
| `system.memory.read` | `observe`、`execute` | `none` | 按引用分页读原文：输入、源码、结果、笔记与材料都用它。 |
| `system.memory.update` | `execute` | `write` | 改自己的一份笔记，交回它的新版本。 |
| `system.memory.plan` | `execute` | `write` | 改自己的任务计划：只给要改的字段，其余保留，交回整份计划。 |
| `system.memory.retain` | `execute` | `write` | 保留一份笔记或执行结果的自动展示；不重跑脚本。 |
| `system.memory.release` | `execute` | `write` | 释放一份笔记或执行结果的自动展示，原文仍可召回。 |
| `system.memory.organize` | `execute` | `write` | 声明下一阶段的 focus 与必须保留的引用，安排在下一次模型请求之前整理上下文；只是排队，结果出现在下一帧的 memoryStatus.maintenance。 |
| `system.memory.recall` | `observe`、`execute` | `none` | 分页召回长期记忆，含正文。 |
| `system.memory.save` | `execute` | `write` | 写一条长期记忆：同一个 id 整条覆盖，tags 不给就沿用原来的。防止过期写时，把 recall/save 的 revision 作为 expectedRevision；null 表示只许新建，省略版本表示最后提交覆盖，冲突报 CONFLICT 后重读再决定。 从 recall 更新时先解构 const { revision, updatedAt, ...entry } = previous，再 save({ ...entry, content: 新正文, expectedRevision: revision })；revision 与 updatedAt 是读取结果字段，不直接放进写入输入。 |
| `system.memory.remove` | `execute` | `write` | 删掉一条长期记忆的原文；与 release 只释放当前任务的展示不同。可把 recall/save 的 revision 作为 expectedRevision，只删除该版本；null 要求条目不存在，省略版本删除当前条目，冲突报 CONFLICT。 |
| `system.store.list` | `observe`、`execute` | `none` | 分页列出能访问的空间。 |
| `system.store.keys` | `observe`、`execute` | `none` | 分页列出一个空间里自己能读的对象元数据；正文用 get 读。 |
| `system.store.get` | `observe`、`execute` | `none` | 读一个对象与它的版本：没建过是 null，删掉的是墓碑。 |
| `system.store.events` | `observe`、`execute` | `none` | 读订阅里的消息正文；没订阅过是 null。 |
| `system.store.read` | `observe`、`execute` | `none` | 分页读别人 share 过来的共享材料正文。 |
| `system.store.subscribe` | `execute` | `write` | 订阅主题前缀；相同的声明保留进度。 |
| `system.store.ack` | `execute` | `write` | 业务处理完之后逐条确认消息；只能确认自己订阅范围里的。 |
| `system.store.watch` | `execute` | `write` | 替换一个空间的关注集合；相同的声明不重置进度。 |
| `system.store.publish` | `execute` | `write` | 发布一条独立消息，每次调用都单独保存。 |
| `system.store.share` | `execute` | `write` | 把本会话的原文复制成绑定在键上的共享材料；接收者用 read 读，拿不到源会话的访问权。 |
| `system.store.set` | `execute` | `write` | 按版本创建或整份替换一个对象，可以同一事务发布一条消息。 |
| `system.store.remove` | `execute` | `write` | 按版本删除一个对象，保留墓碑。 |
| `system.store.create` | `execute` | `write` | 创建一个独立的持久空间，返回稳定 id；重启之后用 list 找回来。 |
| `system.modules.list` | `observe`、`execute` | `none` | 分页列出模块，可按 space 只看系统成员或业务能力。 |
| `system.modules.search` | `observe`、`execute` | `none` | 按关键词找模块：匹配模块名、简介与操作名。 |
| `system.modules.describe` | `observe`、`execute` | `none` | 读模块或指定导出的合同；exports 可同次读取多个导出及去重的依赖类型，指定导出时示例按 template: true 读取。 |
| `system.executions.read` | `observe`、`execute` | `none` | 按游标读取状态与有界 stdout/stderr；运行时合并输出变化，避免逐行查询。终态后仍可取剩余输出。 |
| `system.executions.wait` | `observe`、`execute` | `none` | 等待已有执行结束并读取有界输出；waitMs 为整数毫秒 1..60000，默认 60000。到期返回当时状态，目标继续运行；终态或 unknown 立即返回。取消仅结束等待，不能等待自身。无需反复 read 或创建定时器程序。 |
| `system.executions.stop` | `execute` | `write` | 请求停止当前任务的一个执行，返回当时状态；继续 read 确认终态及清理。不能停止调用者自身。 |
| `system.programs.publish` | `execute` | `write` | 检查并发布不可变程序，baseRevision 控制同名更新；语法、import 或版本失败不改变已发布名称。 |
| `system.programs.list` | `observe`、`execute` | `none` | 列当前会话授权范围内的程序；重置前的程序不因目录查询恢复可见性。 |
| `system.programs.describe` | `observe`、`execute` | `none` | 读稳定名称的当前版本，或仍可访问的 sourceRef 原版本；只是目录，不重新执行。 |
| `velaros:context-materials.list` | `execute` | `none` | 按当前整理范围分页列用户输入、回复、源码、结果、笔记和历史卷的元数据，不读正文；自动卷整理的目录截至 runtime.modelTool.volume.through。 |
| `velaros:context-materials.read` | `execute` | `none` | 按引用读取本次整理请求或父快照原文的一页，正文在 text。 |
| `velaros:context-materials.submit` | `execute` | `none` | 交来整理补丁：先整份校验，不合格就报错（修正后再交），合格就受理；原生调用成功后宿主完成交付，文本协议继续声明完成。 |
| `velaros:interaction.ask` | `execute` | `none` | 要信息，返回对方的回答；给了 options 或 fields 时对方在卡片上点选或填写。 |
| `velaros:interaction.confirm` | `execute` | `none` | 要确认，返回对方是否同意及不同意的理由；它不代替具体操作的权限校验。 |
| `velaros:widget.show` | `execute` | `none` | 显示一个小部件，立即返回，不等用户操作。 |
| `velaros:agents.profiles` | `observe`、`execute` | `none` | 列出宿主给的配置：名称、能力范围与预算；start/resume 不给 profile 就用第一个。 |
| `velaros:agents.start` | `execute` | `none` | 派发子任务，返回它的 job。 |
| `velaros:agents.resume` | `execute` | `none` | 子任务收束后接着跑同一个会话，已用预算保留；可以换配置、追加材料。 |
| `velaros:agents.reply` | `execute` | `none` | 回答子任务在 job.pending 里的请求。 |
| `velaros:agents.status` | `observe`、`execute` | `none` | 读子任务的状态与结果引用。 |
| `velaros:agents.wait` | `execute` | `none` | 等到子任务提问或结束；status 为 waiting 时 pending 里的请求要 reply。 |
| `velaros:agents.waitAny` | `execute` | `none` | 等集合内任一子任务提问或结束，立即返回该 job；ids 最多 32 个且不能重复。仅结束本次等待，其余子任务继续运行；下一次等待传入仍未处理的任务。 |
| `velaros:agents.cancel` | `execute` | `none` | 取消子任务并等它收束。 |
| `velaros:agents.send` | `execute` | `none` | 给正在跑的子任务发引导。 |
| `velaros:search.profiles` | `observe`、`execute` | `none` | 列出能选的搜索档位、默认的那个与它们的全部资源上限。 |
| `velaros:search.search` | `execute` | `none` | 新建或续查一项有界搜索，返回报告。 |
| `velaros:search.read` | `observe`、`execute` | `none` | 读已发布的报告：snapshot 读当时的原文，按 text/offset/totalChars 续读；current 重读选中证据的现状，按条目 offset、items.length 与 total 续读，保留每项 ok、stamp 和 complete，不把本页当全部证据。两种读取都不调用模型。 |
| `velaros:evidence.query` | `execute` | `none` | 在一个来源里按字面检索候选；source 用本轮实际授权的来源。 |
| `velaros:evidence.read` | `execute` | `none` | 读一个资源并登记成证据：返回证据 id、原文引用与读到的版本。 |
| `velaros:evidence.report` | `execute` | `none` | 交付这次搜索的结论；受理之后声明完成。结论不合约定时报错，修正后再交。 |

修改后先构建 Velaros、运行 `bun run generate:script`，再运行 `bun run generate:act-catalog` 更新本清单；`bun run check:act-catalog` 检查漂移。模板随生成的模型面经 Kernel 的 `describe` 返回，构建时一同复制到发布目录。
