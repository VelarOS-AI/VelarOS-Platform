# capability token 与权限

轴是**贡献**（我给平台加东西）；capability 是**服务**（我提供 / 我要用一个能力实现）。
两者正交：一个 mod 可以只贡献轴、只提供 capability，或两者都有。

契约面：`@velaros-ai/kernel`（`packages/kernel/src/index.ts`）；只要数据不要值的调用方走
`@velaros-ai/kernel/contracts`（`packages/kernel/src/contracts.ts`）。

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
  readonly isolation: KernelModuleIsolation; // 'in-process' | 'worker' | 'remote'
}
```

manifest 的 `module` 节 schema（`VelarosModModuleSectionSchema`）与它一一对应，
另加两个**装载寻址**字段 `entry` / `exportName`——它们只对 installed pack 有意义，
bundled pack 走构建图，没有寻址问题。

> **单一事实来源在 `@velaros-ai/kernel`**：ABI 定义运行态形状，
> 同一个包里的 `mod-manifest` wire schema 是唯一磁盘 JSON schema（`velarosModEnvelopes.parse`）。
> Agent 与产品壳只消费统一入口路由给自己的不透明 section，不再各抄一份 module parser。

### `isolation` 是部署轴，不是架构轴

**进程边界是部署决策，不是架构决策。** 换 `isolation` 值就换部署形态，descriptor 之外零改动。
默认 `'in-process'`——能力 mod 进程内装载是默认，要隔离才声明。`worker` / `remote` 由 Host
注入同一 `KernelModuleIsolationAdapter` 接缝。HostBridge 时代的 `sidecar` 取值已随实现一起删除，
清单里再写它会被 schema 拒收。

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
