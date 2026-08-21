# capability token 与权限

轴是**贡献**（我给平台加东西）；capability 是**服务**（我提供 / 我要用一个能力实现）。
两者正交：一个 mod 可以只贡献轴、只提供 capability，或两者都有。

契约面：`@velaros-ai/kernel/contracts/abi`（`packages/kernel/src/contracts/abi/`）。

---

## 一、capability token

```ts
interface CapabilityToken<TService extends object = object> {
  readonly id: string;
  readonly version: string;
}

interface CapabilityRequirement {
  readonly id: string;
  readonly versionRange?: string;
}

function createCapabilityToken<TService extends object>(
  id: string,
  version = "1.0.0",
): CapabilityToken<TService>;
function requireCapability(
  token: CapabilityToken,
  versionRange?: string,
): CapabilityRequirement;
```

token 是**稳定的服务身份 + 编译期服务类型**；它**不携带任何实现**，
所以可以安全地住在纯契约包里。id 为空即抛。

manifest 的 `module` 节写的就是它们的 JSON 投影：

```ts
const VelarosModCapabilityTokenSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: TrimmedIdSchema.default("1.0.0"),
});
const VelarosModCapabilityRequirementSchema = z.strictObject({
  id: TrimmedIdSchema,
  versionRange: SemverRangeSchema.optional(),
});
```

**形态层宽容**：`provides` / `requires` 里写裸 id 字符串等价于 `{ id }`
（`tolerantCapabilityRef`），`version` 缺省 `'1.0.0'`。

---

## 二、module 节 = `KernelModuleManifest` 的磁盘投影

```ts
interface KernelModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly provides: readonly CapabilityToken[];
  readonly requires: readonly CapabilityRequirement[];
  readonly optionalRequires: readonly CapabilityRequirement[];
  readonly permissions: readonly string[];
  readonly isolation: KernelModuleIsolation; // 'in-process' | 'worker' | 'sidecar'
}
```

manifest 的 `module` 节 schema（`VelarosModModuleSectionSchema`）与它一一对应，
另加两个**装载寻址**字段 `entry` / `exportName`——它们只对 installed pack 有意义，
bundled pack 走构建图，没有寻址问题。

> **单一事实来源在 `@velaros-ai/kernel/contracts/abi`**；
> `packages/agent/src/protocol/mods.ts` 里那份是它的**磁盘 JSON 投影，不是第二个定义**。
> schema 住 `@velaros-ai/agent/protocol` 而不是 core，是因为**依赖方向**：契约层不得反向依赖 Kernel 库。
> Kernel 侧读同一节时用它自己的窄读取器——各读各节，正是分节信封要的形状。

### `isolation` 是部署轴，不是架构轴

**进程边界是部署决策，不是架构决策。** 换 `isolation` 值就换部署形态，descriptor 之外零改动。
默认 `'in-process'`——能力 mod 进程内装载是默认，要隔离才声明。

---

## 三、模块定义与生命周期

```ts
defineKernelModule({
  manifest: {/* KernelModuleManifest */},
  activate(context: KernelModuleActivateContext) {
    /* … */
  },
});
```

Kernel 生命周期：`register → activate → ready → suspend → dispose`。
`KernelServiceHandle` 是**generation 绑定的服务租约**——provider 被替换后旧句柄即失效，
不做「静默用旧值」。

---

## 四、权限 broker（默认 deny，不可旁路）

```ts
type KernelPermissionDecision =
  | { readonly status: "granted"; readonly grantId?: string }
  | { readonly status: "denied"; readonly reason: string };

/** Host-owned authority boundary. Modules never implement or replace it. */
interface KernelPermissionBroker {
  request(request: KernelPermissionRequest): Promise<KernelPermissionDecision>;
}

/** Module-scoped view that cannot forge module or generation identity. */
interface KernelModulePermissionBroker {
  request(
    request: KernelModulePermissionRequest,
  ): Promise<KernelPermissionDecision>;
}
```

三条要点：

1. **broker 是宿主拥有的权威边界——模块永不实现、永不替换它。**
2. mod 拿到的是 `KernelModulePermissionBroker`——**它伪造不了 moduleId 与 generation**
   （宿主侧的 `KernelPermissionRequest` 才带这两个字段）。
3. **默认 deny。** `denied` 分支强制带 `reason`，
   拒绝必须能被解释给用户看，不许静默失败。

`scope?: ScopeRef` / `resource?: ResourceRef` 是**不透明引用**——
mod 拿到的是引用不是路径，这是权限面能被审计的前提。

### manifest 里的 `permissions` 今天是什么

`agent` 节的 `permissions` 字段**v1 只是声明与审计元数据**。
既有的工具类别可见性门不消费该字段——
**manifest 不得声称「走七门」**，七门管的是工具类别可见性，不 enforce mod 的能力 scope。
真正的能力 enforcement 在 Kernel capability broker：Platform 提供 ABI，具体宿主负责公开权限
目录、导入确认、授权账本与审计。Desktop 已把它接入 `.velarmod` 扫描/导入流程；其他宿主没有
显式装配 broker 时仍是默认 deny，不能因为 manifest 有声明就视为已经获权。

`module` 节的 `permissions` 是 `KernelModuleManifest.permissions`，
它是 broker 请求的合法性依据（模块申请自己没声明的权限即越界）。
完整包格式、当前 Desktop 权限目录与逐项批准流程见
[package-format-v1.md](./package-format-v1.md)。

---

## 五、案例：记忆后端 = capability token，不是第十根轴

记忆后端是**第一个完全用既有轴装出来的能力域**——它的价值恰恰在于「没为它改任何机制」。

### 5.1 为什么不开轴

为记忆开一根 `memoryBackends` 轴，下一个能力域就会照抄，
五套并行扩展系统会按域重新长回来。
所以后端经 **capability token 族**注册与发现，走既有 mod 轴与 capability registry。

### 5.2 token 族

`packages/memory/src/adapter-kernel/MemoryStoreCapability.ts`：

```ts
export const MemoryStoreCapabilityNamespace = "velaros.memory.store";
export const DefaultMemoryStoreCapabilityVersion = "1.0.0";

export interface MemoryStoreCapabilityService {
  readonly backend: MemoryStoreBackend;
}

export function memoryStoreCapabilityId(backendId: string): string;
// → `velaros.memory.store.${backendId}`，空 id 即抛

export function createMemoryStoreCapabilityToken(
  backendId: string,
  version = DefaultMemoryStoreCapabilityVersion,
): CapabilityToken<MemoryStoreCapabilityService>;

export function createMemoryStoreKernelModule(
  options: CreateMemoryStoreKernelModuleOptions,
): KernelModuleDefinition;
```

**为什么一个后端一个 token 而不是一个共享 token**：
`KernelServiceStore` 对同一 capability id 只允许一个 active 服务（重复注册即 `DUPLICATE_SERVICE`）。
三档后端要能**叠加**，就必须各占一个 id——共享 id 会把叠加语义降级成三选一。

**为什么是普通服务对象而不是 callable capability**：
后端解析是记忆产品**进程内**的实现选择，消费者只有适配器本身；
对外那张需要审计与权限门的面仍然是 `velaros.memory`，一条没减。

**为什么 token 住 adapter-kernel 而不是主干**：
token 是 mod 轴机制；主干只该持有与实现无关的窄动词契约。
方向铁律 `adapter-kernel → 主干` 单向也强制了这个落点。
它也不能住 Kernel：`packages/kernel/src/**` 有具体能力语义硬墙，出现 `memory` 一词即红。

### 5.3 窄端口

`packages/memory/src/backend/Contract.ts` 只描述**动词**，不假设后端是树、是文件还是向量库：

```ts
export type MemoryBackendRole = "authority" | "derived-index";

export type MemoryBackendVerb =
  | "capture"
  | "recall"
  | "inspect" // 必备：任何后端的入场券
  | "erase"
  | "dream"
  | "govern"; // 可选：按能力声明

export interface MemoryBackendDescriptor {
  readonly id: string; // 'files' / 'tree' / 'vector'；token 由它派生
  readonly role: MemoryBackendRole;
  readonly displayName: string;
  readonly verbs: readonly MemoryBackendVerb[];
}
```

**可选动词缺席时，实现上必须真的缺席，而不是抛 not-implemented**——
「没装就没有」复用 partial activation 语义，不新造降级词汇。

`MemoryBackendStats` 刻意**不复用** `MemoryTreeDiagnostics`：
那是树后端的 schema（concept / episode / claim / dreamRun / treeVersion），
窄端口一旦返回它就等于把树形态钉进契约。

### 5.4 三档与叠加

| 档     | mod             | 分发               | 角色                               | 缺席时                                                     |
| ------ | --------------- | ------------------ | ---------------------------------- | ---------------------------------------------------------- |
| 默认档 | `memory-files`  | **bundled 恒装**   | **权威层**：markdown + frontmatter | 不存在——恒装                                               |
| 增强档 | `memory-vector` | 市场可选           | **派生索引**：语义召回增强         | recall 退回文件索引 + 全文检索，**功能面不缺**只是召回变笨 |
| 未来档 | `memory-tree`   | 市场可选（未发布） | 加密树后端                         | 不存在——未发布                                             |

- **files = 权威层，恒在**：记忆内容的唯一真相住在文件里。
- **vector 装后**：capture **双写**（文件权威 + 索引派生）；
  recall **并联**（语义命中 → **回文件取全文**）。
  回文件取全文是为了让索引永远只持有指针与向量，不持有内容副本——
  否则「删索引」就变成了删内容。
- **卸载 vector = 只删派生索引，权威内容零丢失。**

这是 orphaned-but-preserved 的**标准案例**：派生物可以随 mod 走，**权威内容永远不随 mod 走**。

### 5.5 与数据生命周期的对齐

| 动作             | 记忆后端的落法                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| install          | 注册后端，不触碰任何既有记忆数据                                                                                                              |
| enable / disable | disable `memory-vector` → 派生索引进 orphaned-but-preserved，权威文件零变化；重新 enable **重建即可**（派生物天生可重建，不需要「复活」语义） |
| uninstall        | 两段式照旧；`memory-vector` 的「清理数据」删的只是索引。`memory-files` 恒装，**不提供卸载路径**——卸载权威层不是卸载语义，是删数据             |
| upgrade          | 索引 schema 变更走**重建**而非迁移                                                                                                            |
| `ownerModId`     | 打在**派生索引**一侧；**权威文件不打 mod 标签**——权威内容不属于任何 mod                                                                       |

Platform 侧的实现地图见 [`docs/memory/memory-backends.md`](../memory/memory-backends.md)。
