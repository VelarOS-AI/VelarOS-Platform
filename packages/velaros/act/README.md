# Act 能力目录

<!-- 由 scripts/script/act-catalog.mjs 从真实装配定义生成。 -->

当前共 12 种底层合同投影、74 个投影操作、43 项去重后的用法；其中系统包包含 3 个成员、22 个基础自管理操作，装配长期记忆时额外提供 recall/save/remove。同一会话的 memory 和 store 各使用一份实际授权合同。实际可用项由宿主配置、会话作用域和当前授权决定。

| 目录 | 模型操作 | 可用条件 | 使用模板 |
| --- | --- | --- | --- |
| [system/ — store](system/MODULE.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`publish`、`share`、`set`、`remove`、`watch`、`create` | 获配创建空间能力 | [store-template.js](system/store-template.js) |
| [system/ — store-write](system/MODULE.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`publish`、`share`、`set`、`remove`、`watch` | 获配空间写入范围 | [store-write-template.js](system/store-write-template.js) |
| [system/ — store-read](system/MODULE.md) | `list`、`keys`、`get`、`events`、`read`、`subscribe`、`ack`、`watch` | 共享空间只读授权 | [store-read-template.js](system/store-read-template.js) |
| [system/ — modules](system/MODULE.md) | `list`、`search`、`describe` | 默认装配 | [modules-template.js](system/modules-template.js) |
| [system/ — memory-local](system/MODULE.md) | `list`、`read`、`update`、`retain`、`release` | 搜索或未启用整理的会话 | [memory-local-template.js](system/memory-local-template.js) |
| [system/ — memory-long-term](system/MODULE.md) | `recall`、`save`、`remove`、`list`、`read`、`update`、`retain`、`release`、`organize` | 主线宿主配置 memory；整理按实际模型配置生成 | [memory-long-term-template.js](system/memory-long-term-template.js) |
| [system/ — memory](system/MODULE.md) | `list`、`read`、`update`、`retain`、`release`、`organize` | 具备整理模型的主线或业务子任务 | [memory-template.js](system/memory-template.js) |
| [system/ — context-materials](system/MODULE.md) | `list`、`read` | 整理作用域 | [context-materials-template.js](system/context-materials-template.js) |
| [agents/ — interaction](agents/MODULE.md) | `ask`、`capability`、`confirm` | 默认装配 | [interaction-template.js](agents/interaction-template.js) |
| [agents/ — agents](agents/MODULE.md) | `profiles`、`start`、`resume`、`reply`、`status`、`wait`、`cancel`、`send` | 宿主配置 agents | [template.js](agents/template.js) |
| [search/ — search](search/MODULE.md) | `profiles`、`search`、`read` | 宿主配置 search | [template.js](search/template.js) |
| [search/ — evidence](search/MODULE.md) | `query`、`read` | 搜索作用域 | [evidence-template.js](search/evidence-template.js) |

共享会话、协议解析、程序版本、结果租约与五分区组装位于 [runtime/](runtime/MODULE.md)。搜索执行与预算在 [search/](search/MODULE.md)。

每个职责组统一管理契约、类型和实现。`impl/*Module.ts` 定义实际 schema、效果和处理器；对应模板位于组目录。单份类型或配置直接放成文件，多份内容才分目录。

模型使用示例：

```js
import { output } from 'velaros';
import { modules } from 'velaros:system';
const usage = await modules.describe({ module: 'velaros:system', export: 'memory' });
output(usage.template, { type: 'code' }); // 按需读取模型用法；精确参数见 usage.declarations
```

模型从 `velaros:system` 导入自管理成员。宿主的 `@velaros-ai/velaros/act/system` 入口提供装配实例和端口类型；[系统入口模板](system/template.js) 展示基本使用。

| 操作 | 允许入口 | 声明效果 | 用途 |
| --- | --- | --- | --- |
| `system.store.list` | `observe`、`execute` | `none` | 分页发现获配空间；active=true 只列出当前任务使用的空间引用 |
| `system.store.keys` | `observe`、`execute` | `none` | 分页列出指定空间授权前缀内的对象元数据；正文用 get 获取 |
| `system.store.get` | `observe`、`execute` | `none` | 按空间和键读取当前 JSON 对象及版本；未创建返回 null，删除返回墓碑 |
| `system.store.events` | `observe`、`execute` | `none` | 读取订阅内逐条消息正文；默认 pending=true 只读未处理消息，窗口缺口用 gap 明确返回 |
| `system.store.read` | `observe`、`execute` | `none` | 分页读取 share 发布的真实材料，不能通过任意会话引用越权读取 |
| `system.store.subscribe` | `execute` | `write` | 订阅主题前缀；省略 after 从当前消息头开始，相同声明保留进度，空 topics 取消订阅 |
| `system.store.ack` | `execute` | `write` | 业务处理完成后逐条确认消息；已投递不等于已处理，身份必须在当前订阅权限内 |
| `system.store.publish` | `execute` | `write` | 发布独立消息，保留每次调用；主题按空间写前缀授权，正文最多 16 KiB |
| `system.store.share` | `execute` | `write` | 把本会话原文复制为键绑定的共享材料；接收者用 read 分页读取，不获得源会话访问权 |
| `system.store.set` | `execute` | `write` | 按 baseRevision 创建或完整替换对象；冲突后重读，0 只用于新键；event 可与对象同一事务发布 |
| `system.store.remove` | `execute` | `write` | 按版本删除对象，保留墓碑；对象删除不影响空间本身 |
| `system.store.watch` | `execute` | `write` | 替换指定空间的持久关注集合；空集合取消，相同声明不重置进度；先 watch 再读取基线 |
| `system.store.create` | `execute` | `write` | 创建独立持久空间，返回稳定 id；名称不是授权，重启后通过 list 发现 |
| `system.modules.list` | `observe`、`execute` | `none` | 按当前授权与空间筛选后分页列出包 |
| `system.modules.search` | `observe`、`execute` | `none` | 在当前授权包中按关键词和空间检索 |
| `system.modules.describe` | `observe`、`execute` | `none` | 读取包合同；system 可按 export 指定成员 |
| `system.memory.list` | `observe`、`execute` | `none` | 按种类和标题分页查找当前任务材料；只返回引用、位置、大小和笔记版本 |
| `system.memory.read` | `observe`、`execute` | `none` | 统一分页读取输入、源码、结果、笔记和材料原文；读取不续租、不执行脚本 |
| `system.memory.update` | `execute` | `write` | 维护自己的笔记或计划；笔记用 key/baseRevision，计划用 plan；只在 execute 中调用 |
| `system.memory.retain` | `execute` | `write` | 保留当前笔记或执行结果；结果 turns 为成功业务回合数或 task，笔记驻留到主动释放；不重跑脚本 |
| `system.memory.release` | `execute` | `write` | 释放笔记或执行结果的自动展示，原文仍可召回 |
| `system.memory.recall` | `observe`、`execute` | `none` | 分页召回宿主作用域中的长期记忆，含正文；id 精确读取，query 按标题、描述、标签和正文匹配；历史记忆使用前应核实 |
| `system.memory.save` | `execute` | `write` | 将值得跨会话保存的用户偏好、反馈、工作决定或资源位置写入长期记忆；同 id 整条覆盖，tags 省略沿用；只在 execute 中调用 |
| `system.memory.remove` | `execute` | `write` | 显式删除一条长期记忆；与 release 当前任务驻留不同，本操作删除磁盘原文 |
| `system.memory.organize` | `execute` | `write` | 声明下一阶段 focus 和需保留引用 preserve，安排下一请求前整理；返回 scheduled 和 requestId，实际结果自动进入下一帧 |
| `velaros:context-materials.list` | `execute` | `none` | 列举快照材料的元数据，不隐式读取正文 |
| `velaros:context-materials.read` | `execute` | `none` | 按快照中的引用读取父会话原文页 |
| `velaros:interaction.ask` | `execute` | `none` | 向用户请求信息，等待指定交互的回答 |
| `velaros:interaction.capability` | `execute` | `none` | 向宿主或父任务说明缺少的能力；回答不授予权限，可先交付当前进度，再由父任务更新环境续跑。 |
| `velaros:interaction.confirm` | `execute` | `none` | 向用户请求确认，交互答案不代替具体操作的权限校验 |
| `velaros:agents.profiles` | `observe`、`execute` | `none` | 列出实际可选配置的名称、能力范围和预算；start/resume 使用 name。 |
| `velaros:agents.start` | `execute` | `none` | 派发子任务；stores 显式共享空间及读写前缀，每项 write 必须是该项 read 的子范围，materials 复制原文，writes 是外部模块写锁。 |
| `velaros:agents.resume` | `execute` | `none` | 在子任务收束后续跑同一会话，保留已用预算；profile/writes/stores 可替换工作环境，materials 追加材料。 |
| `velaros:agents.reply` | `execute` | `none` | 回答指定子任务请求；请求出现在 job.pending 中。回答不改变权限，环境更新需收束后 resume。 |
| `velaros:agents.status` | `observe`、`execute` | `none` | 读取子任务状态和结果引用。 |
| `velaros:agents.wait` | `execute` | `none` | 等待子任务提问或结束，不额外调用模型；pending 中的请求需要 reply。 |
| `velaros:agents.cancel` | `execute` | `none` | 取消并等待子任务收束。 |
| `velaros:agents.send` | `execute` | `none` | 向活动子任务发送引导，新输入抢占尚未接受的模型响应。 |
| `velaros:search.profiles` | `observe`、`execute` | `none` | 查看可选搜索档位、默认项和实际资源上限。 |
| `velaros:search.search` | `execute` | `none` | 新建或续查有界搜索；profile 来自宿主，resume 使用上一报告引用。 |
| `velaros:search.read` | `observe`、`execute` | `none` | snapshot 按 UTF-16 字符读取历史报告；current 按证据项 offset/limit 刷新已选目标，不调用模型。 |
| `velaros:evidence.query` | `execute` | `none` | 按来源和字面查询检索已授权候选；内部查询独立计费。 |
| `velaros:evidence.read` | `execute` | `none` | 读取真实目标并登记不可变证据 ID、原文引用和版本。 |

修改后先构建 Velaros，再运行 `bun run generate:act-catalog` 更新本清单；`bun run check:act-catalog` 检查漂移。模板由模块装配并经 Kernel 的 `describe` 返回，构建时一同复制到发布目录。
