# 分发：bundled / installed / 市场 / 整合包

一个 mod 到达用户机器有四条路。它们的**信任级、寻址方式、失败面**都不同。

---

## 一、bundled = 编译期依赖

**`bundled` 不是「随包下载物」，是构建图上的一条普通依赖。**
谁编进来谁负责，构建图解析不了就是**构建期红**——运行时没有这一类失败面。

### Kernel 侧

`packages/kernel-serve/src/daemon/daemon/bundled-packs.ts`：

```ts
export interface KernelBundledPack {
  readonly id: string
  readonly version: string
  readonly provides: readonly string[]
  /** 编译期就在手的模块定义；specifier 只是身份回显，永不被 import。 */
  readonly module: KernelModuleDefinition
}

export function bundledPackSpecifier(moduleId: string): string   // → `bundled:${moduleId}`
export function createBundledModPack(input: { id; module; version?; provides? }): KernelBundledPack
export function toBundledPackRecords(packs?): readonly KernelModPackRecord[]
export function registerBundledPacks(store: KernelModStore, packs?): readonly KernelModPackRecord[]
export const BundledKernelPacks: readonly KernelBundledPack[]
```

**`specifier` 是身份 URI，不是磁盘路径**：installed pack 的 specifier 可 import，
bundled pack 的是 `` bundled:<moduleId> ``——带 scheme 的形态把两者机械分开，
避免有人拿它去 `import`。

`BundledKernelPacks` 里今天只有三个 **sidecar 目录桩**
（`system.agent` / `system.model` / `system.browser`）：
能力目录在 Kernel、实现在产品那一侧，`activate` 恒抛错。
它们存在的理由是**目录可见性**——瘦客户端 handshake 前就得知道这个 Kernel 上有哪些能力。

**内核不 import 任何具体能力包。** 具体能力的 bundled pack 归**宿主**的构建图：
宿主静态 import 能力包的 `create*KernelModule()`，用 `createBundledModPack` 折成记录，
经 `bootKernelDaemon({ modPacks })` 注入。
让内核直接 import 能力包 = 把反向依赖焊进内核，架构门当场红。

整批开关：`VELAROS_KERNEL_AUTO_SYSTEM_PACKS=0`（或 `false`）关掉 bundled 登记。
注意 `registerBundledPacks` **刻意不传 `enabled`**——随包默认是「开」，
但用户经 `mods.setEnabled` 停用过的 pack 必须跨重启保持关闭。

### Agent 侧

`assembleAgentMods` 的 `bundled` 缺省 = `[createBuiltinAgentModPackage()]`，
即随包官方内置轴 `velaros.agent.builtin`。传空数组可显式关掉
（Desktop 的 `activatePack` 就是这么做的，避免重复注册）。

装载顺序：**bundled 先、pack 后**（bundled 是有序数组，pack 平铺）。
顺序只决定「谁先占住主键」——**冲突一律拒载并留诊断，不存在后者覆盖前者的加载顺序语义。**

---

## 二、installed = 目录

一个目录 + 一份 `velaros.mod.json`。Desktop 的落法：

| | |
| --- | --- |
| 安装根 | `storage/mods/<packId>/`（`storagePathService.getModPacksDir()`） |
| 注册表 | `storage/mods/mod-registry.json`（`{ disabled?: string[]; external?: string[] }`） |
| 记录类型 | `DesktopAgentModPackRecord extends AgentModPackDescriptorLike`，带 `kind: 'system' \| 'user' \| 'contrib'` 与 `ui: unknown` |
| 服务 | `DesktopModService`：`listPacks()` / `getOverview()` / `setEnabled(id, enabled)` / `installFromDirectory(directory)` / `assembleAgentAxis()` |
| 存储层 | `DesktopAgentModPackStore`：`list()` / `setEnabled(id, enabled)` / `installFromDirectory(directory)` |
| reader | `createDesktopAgentModPackReader()` —— **只实现 `readManifest`**，没有 `loadBindings` |

`kind` 的取法：外部登记目录 → `'contrib'`；安装根下的目录 → `'user'`；
`'system'` 今天只出现在类型联合里。版本读不出时回落 `'0.0.0'`。

### 已知缺口（如实登记）

- **没有 uninstall**：`DesktopModService` 与 `DesktopAgentModPackStore` 都不提供卸载。
  disable 是唯一的移除路径。3.7 的两段式 uninstall **契约已定，实装未开始**。
- **没有 `loadBindings`**：installed pack 拿不到运行态绑定，
  因此**贡献不了 `tools` 与 `hooks`**（缺绑定即拒载）。
- **信任级门只放 bundled-official**：见 [getting-started.md §六](./getting-started.md#六现状与限制先读这条)。

---

## 三、市场

市场链路今天走的是**旧插件管道**（`AppResourcePluginInstaller`），
它与 mod 的 pack 存储是两套东西。现状与缺口在
[integration.md §三](./integration.md#三旧插件市场--appresourceplugin--p5-收敛对象)：

| 能力 | 现状 |
| --- | --- |
| sha256 自校验 | ✅ 有（**防传输损坏，不是作者认证**） |
| Ed25519 签名 / 内置公钥验签 / 吊销名单 | ❌ 欠账 |
| 版本化寻址（去 latest-only） | ❌ 欠账 |
| 回滚 | ❌ 欠账 |
| 原子安装 | ⚠️ `rm` + `rename` 两步，中间崩溃无恢复 |

**签名底线的判决**：`marketplace-signed` 需要「发布方私钥签名 / App 内置公钥验签 / 吊销名单」。
可挪用的现成 Ed25519 基建是邀请码签发脚本 `invite-code.mjs`
（私钥签发 + App 内置公钥 WebCrypto 验签）。
落地时点判决：**版本化寻址 + 签名验签 + 回滚 + id 闭集开放化随第一个非 bundled 消费者先行落地**，
不等 M5——因为独立分发一旦发生，「app 升级静默炸外部包」就从假想变成现实。

**在签名与版本化寻址就绪之前，不要把 `trust: 'marketplace-signed'` 当成一条可用路径。**
它的加载路径实例数今天是零。

---

## 四、整合包（modpack）= lockfile

**L3 占位，未实现。**

判决只有一句：**整合包 = lockfile**——精确枚举成员 + 版本 + 顺序。
冲突复杂度推给整合包**作者策展时**解决，运行时只做**平铺加载 + 确定性顺序**。

**不写依赖求解器。** mod↔mod 的 `depends` / `conflicts` 字段
**不预置进 v1 schema**（M5 前零消费者，焊进冻结 schema 违反自家 YAGNI 律）；
真需要时靠 `manifestSchemaVersion` 平滑加字段。

> **先例参照**：Minecraft 的 modpack 生态几十年只做对了一件事——
> 整合包是一份**被人策展过的清单**，不是一个求解器的输出。
> 求解器让作者以为冲突会被自动解决，于是没人去策展；
> lockfile 让作者必须当场面对冲突，而这正是整合包的价值所在。

首个真消费者是**官方出厂包**（= 当前完整产品形态，最好的自证）。
用户级整合包语义（导入的合并 / 替换、已有配置去向、回滚、切包数据归属）
推到市场链路就绪之后——**不为零人生态预建用户级导入语义**。

---

## 五、认证 = agent-lab 模型

mod 的质量门不是单测，是**真机跑分**。成本现实：一轮摩擦电池 ~45 分钟 + BYOK token +
LLM 非确定性，**不可能**做到「每 mod × 每内核版本全量跑」。

因此认证分三档：

| 对象 | 认证方式 |
| --- | --- |
| **bundled 官方 mod** | 随主 friction 门跑（既有流程） |
| **外部 mod 上架** | **官方审核 + 抽样跑电池**（非全跑） |
| **mod 自带电池** | manifest 的 `battery` 字段指向旅程电池入口；**在认证机沙箱内执行 mod 的任意 JS** |

三条约束：

1. **认证是抽检，不是普适门。**
2. **认证环境必须隔离**，且 hook 桥无自批准权限——
   跑一个陌生 mod 的电池 = 在认证机上执行陌生代码。
3. 电池形态铁律：**「同一会话持续推进一个任务」的连续旅程**，
   不写散装单测 / 逐案例开会话的探针。

构建期还有一层机械检查（`arch-guard` 的 `architectureChecks` 数组）：

- `modManifestIntegrity`：bundled mod manifest 过 schema + 贡献引用存在性 + `engines` 字段存在；
- `noEnumDispatchRegression`：对空间枚举成员的直接文本引用数做**棘轮**，只减不增。

仓库**不设单测层**——质量门只有两层：构建期 check 链 + agent-lab 真机跑分。
写 mod 时不要为它新建测试目录；要锁的规则做成 check 或 agent-lab 场景。
</content>
