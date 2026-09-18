# @velaros-ai/project

项目空间：把 agent 能用的能力装配到一个项目根里。它自己不实现任何一件能力——能力都在 `@velaros-ai/velar` 里，一件只有一份实现；
项目空间只回答「这个空间挂哪几件、每件用什么端口」。两个入口：

- `@velaros-ai/project`：给 Node 宿主。装配表 `createProjectSpace`、交给 agent 编码会话的验证判据 `projectVerificationPolicy`，
  以及宿主要实现的端口 `ProjectHostPort` 与每次调用的上下文 `ProjectCallContext`。
- `@velaros-ai/project/contracts`：常量表（空间身份 `ProjectSpaceId`），浏览器和渲染进程也能用。

## 挂哪几件

模型写程序、import 能力模块。项目空间挂五个：

```text
velar:project   read / list / search / edit / inspect / undo   受项目治理的文件（@velaros-ai/velar/project）
velar:code      query / analyze                               代码之间的关系（@velaros-ai/velar/project）
velar:shell     run / listTasks / refreshEnvironment          命令（@velaros-ai/velar/shell，配项目端口）
velar:sandbox   create / run / diff / apply / discard         演练沙箱（@velaros-ai/velar/sandbox，配项目端口）
velar:images    view                                          看图（@velaros-ai/velar/images，配项目端口）
```

常驻的是项目文件与命令（`velar:project`、`velar:shell`），其余三件模型 import 了才拿到完整声明。

## 给共用能力装的项目端口

- 命令：工作目录按真实路径钳在项目内；只读命令直接跑，会改项目的命令先过宿主的修改授权，前台命令在项目资源门里排队（与两件项目工具共用一扇门）；输出交给程序之前过内核的脱敏后端。
- 演练沙箱：只镜像项目内的目录；落回前先把每条路径过一遍项目的写治理（越界、拒写名单、受保护与生成文件、宿主可见范围），有一条不许写就整批拒绝，再过一次修改授权，都排在问用户之前。
- 看图：只看项目里、读取策略许看的图；裁图缩图用宿主的能力，宿主没有就明说做不了。

## 宿主怎么接

```ts
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { createProjectSpace, type ProjectCallContext } from '@velaros-ai/project'
import { createProjectKernel } from '@velaros-ai/velar/project'

const kernel = await createProjectKernel({ root: authorizedProjectRoot })
const space = createProjectSpace({ resolveCall: (): ProjectCallContext => ({ abortSignal, approval, sessionId, project: host }) })
const capabilities = createCapabilityPort(space.operations)
```

`host` 是宿主对 `ProjectHostPort` 的实现：项目根、按项目根缓存的内核（`kernel: async () => kernel`）、修改授权、代码查询，
加上跑命令、列后台任务、刷新 shell 环境，可选的演练沙箱与缩图。内核、事务控制与落盘的变更记录怎么建，见 `@velaros-ai/velar` 的说明。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)。
