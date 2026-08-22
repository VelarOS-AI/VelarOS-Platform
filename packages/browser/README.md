# @velaros-ai/browser

> **位置**:VelarOS-Platform 单版本火车 · `capabilities` 域 · 目录 `packages/browser`。
> 它是**浏览器能力的唯一家**:CDP 自动化内核、agent 工具集合、React 合成边界、
> Electron 会话运行时。域归属由仓根 `package.json` 的 `velaros.domainPackages` 声明,不看目录深浅。

## 这个包解决什么问题

让 agent 真的会用浏览器:打开页面、看清楚页面上有什么、点击输入、等待、抓网络与控制台事件、
处理弹窗 / 下载 / 权限请求、截图录屏、导出内容、做性能分析、把一串操作沉淀成可复跑的 recipe。

难点不在「调一次 CDP」,而在**同一套检查 / 动作协议要能同时跑在两种载体上**:
Electron 内嵌 WebContents,和外部 Chrome 的 CDP 连接。本包的答案是把两者都收敛到
`BrowserPageDriver` 这一个协议后面——上层的引擎与工具只认 driver,不认载体。

## 对外分区

**本包刻意没有根导出。** 各切片的运行面互斥(host 无关 / React / Electron),
合成一个根入口会让 renderer 侧 bundle 顺着根 index 把 Electron 代码一起拽进去
——**这正是必须靠子路径切分守住的墙**。

| 子路径 | 源码 | 运行面 |
| --- | --- | --- |
| `@velaros-ai/browser/core` | `src/core` | host 无关的 CDP 自动化运行时、驱动、策略、脚本构建器 |
| `@velaros-ai/browser/core/contracts` | `src/core/contracts.ts` | 浏览器安全 DTO + 确定性策略(无 Node 内置模块) |
| `@velaros-ai/browser/tools` | `src/tools` | 宿主注入式的 40 个 `browser:*` canonical agent 工具 |
| `@velaros-ai/browser/composition` | `src/composition/BrowserCompositionProvider.tsx` | renderer-safe React 合成边界(peer `react`) |
| `@velaros-ai/browser/composition/mod` | `src/composition/mod.ts` | 宿主侧 Mod Loader 定义；会绑定完整工具集合，renderer 不得导入 |
| `@velaros-ai/browser/runtime` | `src/runtime` | Electron 会话 / 自动化运行时(peer `electron`) |

`react` 与 `electron` 都是**可选 peer**:只用 `./core` / `./tools` 的宿主两个都不用装。
切片细节各见 `docs/<slice>/README.md`。

## 核心概念

**`BrowserPageDriver` 是那道接缝**。页面检查与动作的协议由它定义;
`CdpBrowserPageDriver`(外部浏览器 / WebSocket CDP)与
`ElectronWebContentsBrowserPageDriver`(内嵌 WebContents)是它的两个实现。
四大引擎(交互 / 页面数据 / 截图 / 等待)里**走 driver 的那一半是 host 中立的**,
只有 WebContents 独有的分支才留在 Electron 侧。

**脚本构建器单源**。所有注入页面的 JS 由 `BrowserPageScriptBuilder` 一族统一生成
(检查、抽取、滚动、等待、上传、拖拽、存储读取、媒体源枚举……),不在调用点散写字符串。

**按会话串行、跨会话并发**。有副作用的动作经 `BrowserSessionActionQueue` 按 `sessionId` 排队;
不同会话互不阻塞。`BrowserPendingEventsBroker` 管 dialog / download / permission 这类
**需要人或策略来结算的挂起事件**的超时与结算。

**登录墙**。`BrowserLoginDetection` 负责识别「撞上登录 / 验证 / 支付」这类必须交还给人的场景。

**工作区制品与 recipe 策略归 Browser Core**。`BrowserWorkspaceFileAccess` 负责主根内写入、
主根优先且历史根只读的兼容访问；`BrowserRecipePreview` 负责 recipe 路径、同源与预览投影。
Desktop 只注入站点根、Electron 会话和产品 IPC，不再各自维护一份浏览器领域规则。

**CDP 侧的登录态与 Electron partition 互不通**:CDP profile 按 member / site 存在宿主注入的
数据根下,**刻意不与 Electron partition 互操作**——两套登录存储不桥接是判决,不是欠账。

## 典型用法

host 无关的 CDP 路线(不需要 Electron):

```ts
import {
  BrowserPageScriptBuilder,
  CdpBrowserRuntime,
  CdpExternalBrowserLauncher,
} from '@velaros-ai/browser/core'
import { browserTools } from '@velaros-ai/browser/tools'

const runtime = new CdpBrowserRuntime({
  scripts: new BrowserPageScriptBuilder(),
  artifactAccess: myFileAccess,          // 产物读写端口由宿主注入
  foregroundBrowserLauncher: new CdpExternalBrowserLauncher(),
})
// runtime.bindBrowserApi(...) 得到的 ToolBrowserApi 即可喂给 browserTools
```

Electron 宿主在此之上叠 `@velaros-ai/browser/runtime`;renderer 只取
`@velaros-ai/browser/core/contracts`(纯类型 + 纯策略,进 bundle 安全)。

## 边界:本包不负责什么

- **不注册产品 IPC、不拥有聊天 / 会话编排、不 import 渲染进程代码、不依赖 `@velaros-ai/agent`。**
- **Electron 只许在 `src/runtime/**` 下 import**(值和类型都算)——capability 架构门机械执法。
  另外三个切片保持 host 无关。
- **跨切片访问走包内相对 import**(`src/tools` → `../core`),**永远不走包说明符**。
- 工具只定义自己与 context 契约;创建浏览器、保存会话、UI 都是宿主的事。
- CDP 实现不了的 Electron 专属能力**明确返回不支持**,不用伪结果维持表面兼容。

## 与相邻包的关系

- 上游只有 `@velaros-ai/core` 与 `zod`(外加 `gifenc` 用于录屏编码)。
- 与 `@velaros-ai/agent` 是**被注入关系**:本包不 import 它,宿主在装配根把 `browserTools`
  注册进 agent 运行时。
- `src/runtime/kernel-module.ts` 提供可选的 Kernel 模块适配器。
- `vendor/devtools-performance-engine` 是随包发布的性能分析引擎产物,由 `browser:performance` 消费。
- 姐妹能力包:`@velaros-ai/computer`(OS 级桌面控制)、`@velaros-ai/project`(本地代码工作区)。

## 兼容策略

切片子路径就是依赖边界。工具身份统一使用 `namespace:tool` canonical id；Provider 若不接受冒号，
只在传输边界转换成可逆别名，注册表、权限、历史和 Mod 声明始终保存 canonical id。
新增宿主专属能力优先设计成可选方法，版本随平台单版本火车推进。
