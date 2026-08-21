# 快速上手：写一个最小 mod

读完这页你会有：一个能被 Loader 接受的 `velaros.mod.json`、一个标准 `.velarmod` 包、
以及看懂它有没有生效的办法。

**先读 [§六 现状与限制](#六现状与限制先读这条)**——今天 Desktop 上外部 pack 能做什么、不能做什么，
和「契约上允许什么」不是一回事。

---

## 一、最小 manifest

一个 mod **源码目录**里只有一个必需文件：`velaros.mod.json`。对外安装时必须先打成
`.velarmod`，目录本身不是分发格式。

```json
{
  "module": {
    "id": "acme.notes",
    "version": "1.2.0",
    "apiVersion": 1,
    "provides": [{ "id": "velaros.agent", "version": "1.0.0" }],
    "requires": [],
    "permissions": ["fs:read"],
    "isolation": "worker"
  },
  "agent": {
    "id": "acme.notes",
    "version": "1.2.0",
    "manifestSchemaVersion": 1,
    "engines": { "velaros": "^1.0.0", "agent": "^1.0.0" },
    "trust": "local-dev",
    "permissions": ["fs:read"],
    "contributes": {
      "promptSegments": [
        {
          "id": "acme.notes.guidance",
          "stability": "stable",
          "priority": 100,
          "text": "When the user discusses notes, keep the original file paths in the answer."
        }
      ]
    }
  },
  "ui": {
    "settings": {
      "groups": [
        {
          "id": "acme.notes.general",
          "title": "Notes",
          "domain": "extensions",
          "order": 100,
          "fields": [
            {
              "key": "autoIndex",
              "type": "toggle",
              "label": "自动索引",
              "default": true
            }
          ]
        }
      ]
    }
  }
}
```

逐字段的约束见 [axes/README.md](./axes/README.md) 与各轴单页。这里只讲**为什么长这样**：

- **`module.provides` 必须含 `velaros.agent`**，pack 才会被喂给 Agent Loader。
  常量是 `AgentModPackProvidesId`（`= 'velaros.agent'`，与 `AgentCapability` 令牌同值）。
  不含它 → 跳过并留 `mod.pack-not-agent-axis`，交由其 owner module 装载。
- **`module.id` 与 `agent.id` 必须一致**，否则 `mod.envelope-id-mismatch` 拒载。
  两节都带 `id` / `version` 是已知冗余，等 agent 节瘦身时按「跨节元数据留顶层」收拢。
- **`manifestSchemaVersion` 是 `z.literal(1)`**（常量 `AgentModManifestSchemaVersion`），
  写别的值直接拒载。它是 schema 演进通道：将来加字段靠它平滑。
- **`engines.velaros` 必填**，`engines.agent` / `engines.shell` 可选。三轴的判定见下节。
- **`version` 必须是 `x.y.z`**（`SemverVersionSchema`，预发布 / 构建元数据被忽略但不报错）。
- **工具名带 `modId_` 下划线前缀**：冒号与点号在 provider API 层非法
  （Anthropic 工具名 schema 是 `^[a-zA-Z0-9_-]{1,64}$`），所以命名空间只能用下划线。
  官方保留裸名，外部 mod 的工具名须带合法前缀；重名一律拒载。

### `engines` 三轴怎么判

判定器是 manifest 契约里自带的 `satisfiesSemverRange`（单源，Loader 复用）。
支持形态：`*` / `x` / `1.2.3` / `=1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.2.3` / `<2.0.0`，
空白分隔 = 合取，`||` = 析取。**刻意不实现** hyphen range 与预发布优先级——
manifest 兼容轴只做版本范围判定；复杂依赖求解属于包管理器职责，本协议不实现依赖求解器。
range 或 version 非法一律返回 `false`（fail-closed）。

| 字段              | 对什么                                                               | 谁检查                          |
| ----------------- | -------------------------------------------------------------------- | ------------------------------- |
| `engines.velaros` | `AgentModHostProfile.velarosVersion`（Kernel module API 兼容轴）     | Loader，必填                    |
| `engines.agent`   | `AgentModHostProfile.agentApiVersion`（Agent capability API 兼容轴） | Loader，可选                    |
| `engines.shell`   | `AgentModHostProfile.shellVersion`，按 `shellId` 取区间              | 只在宿主声明了 `shellId` 时校验 |

三者任一不兼容 → `mod.engine-incompatible`。
特别注意：声明了对某个壳的区间、但宿主**没自报壳版本**，同样报 `mod.engine-incompatible`
（「无法判定」不等于「放行」）。

---

## 二、运行态绑定（哪些轴要写代码）

manifest 是**声明**；工具的 handler、seam 的 handler 这类**代码**叫**运行态绑定**，
经 `AgentModBindings` 交给 Loader：

```ts
interface AgentModBindings {
  readonly tools?: Readonly<Record<string, VelaTool<any>>>;
  readonly toolCategories?: Readonly<Record<string, ToolCategoryDefinition>>;
  readonly promptSegments?: Readonly<Record<string, PromptSegmentDefinition>>;
  readonly skills?: Readonly<Record<string, AgentSkillDefinition>>;
  readonly subAgentTypes?: Readonly<Record<string, SubAgentTypeDescriptor>>;
  readonly executionModes?: Readonly<Record<string, ExecutionModeDescriptor>>;
  readonly hooks?: Readonly<Record<string, AgentModSeamHandler>>;
}
```

键 = 该轴条目的**稳定主键**（`tools` 用 `name`，其余用 `id`）。三条规则：

| 规则           | 常量                                                | 违反后果                                         |
| -------------- | --------------------------------------------------- | ------------------------------------------------ |
| **必须有绑定** | `PayloadRequiredAxes = { 'tools', 'hooks' }`        | `mod.binding-missing` 拒载（不静默降级成空贡献） |
| **不接受绑定** | `DataOnlyAxes = { 'spaces', 'turnContextSources' }` | `mod.binding-not-allowed` 拒载                   |
| **二选一**     | `promptSegments`：有 `text` 或有绑定                | 都缺 → `mod.binding-missing`                     |

代码钩子只存在于四处白名单：工具 handler、seam handler、provider 注入（fail-closed）、
壳级组件引用（T3 档）。**函数进不了 manifest**——`identityStrategy` 是闭集字符串不是 resolver，
`when?` 是闭集条件不是谓词函数，理由都一样。

---

## 三、在产品宿主中安装

Platform 定义 pack 格式、reader 端口和装载生命周期，但不规定某个产品的安装目录、注册表、
设置界面或进程间通信协议。产品宿主负责实现：

- pack 发现、持久化和版本化寻址；
- `AgentModPackReader.readManifest`，以及代码型贡献需要的 `loadBindings`；
- 启用、停用、升级、卸载和恢复策略；
- 签名验证、信任级映射、权限审批和用户可见诊断。

先在 Platform 仓库完成标准构建：

```bash
bun run mod validate ./acme-notes
bun run mod pack ./acme-notes ./dist/acme-notes-1.2.0.velarmod
bun run mod inspect ./dist/acme-notes-1.2.0.velarmod
```

然后把 `.velarmod` 拖进 Desktop 的 Mods 页。Desktop 会先做只读安全扫描，再显示来源、风险和
`module.permissions` 完整清单；权限默认不勾选，可逐项批准、全部批准或全部取消。未签名包还需要
明确确认信任来源。不要依赖未公开的目录结构或内部接口。
停用必须调用 `loader.deactivate(modId)` 摘除贡献和钩子；用户数据默认保留，清理数据必须是
独立、明确确认的操作。bundled pack 是编译期依赖，不经过运行时安装器，详见
[distribution.md](./distribution.md)。

---

## 四、诊断四态怎么读

设置页的 Mod 注册表把每个 pack 归成四态之一（`SystemModStatus`，`@velaros/ipc`）：

| 状态       | 文案 key                                | 含义                                                |
| ---------- | --------------------------------------- | --------------------------------------------------- |
| `active`   | `settings.modsStatusActive` = 已加载    | 全部声明轴都落了地                                  |
| `partial`  | `settings.modsStatusPartial` = 部分加载 | 有轴在本宿主无落点（`absentAxes` 非空）             |
| `rejected` | `settings.modsStatusRejected` = 拒载    | validate / resolve 阶段被拒，`reasons` 里是可读诊断 |
| `inactive` | `settings.modsStatusInactive` = 未装载  | 被停用，或不属 Agent 轴                             |

每行还带三组轴清单：

- `activeAxes` → `settings.modsAxesActive`「已生效轴」
- `absentAxes` → `settings.modsAxesAbsent`「缺席轴」（宿主不支持该轴的落点）
- `unroutedAxes` → `settings.modsAxesUnrouted`「未接线轴」
  （**缺席轴里「宿主还没接这条线」的那一档**：轴在闭集里合法、将来会接，今天贡献被裁掉）

两者的差别对作者是行动含义：`absentAxes` 可能是「这个壳形态上就没有这条轴」，
`unroutedAxes` 是「Desktop 还没接、接了就生效」。设置页两句分列，不混成一句。

`unrouted` 是 Desktop 自己加的一档，诊断码 `desktop.mod.axis-unrouted`；
轴落点接线失败另有 `desktop.mod.axis-landing-failed`。这两码不在主干契约里。

主干侧的原始诊断在 `AgentModLoadReport.diagnostics`，每条是：

```ts
interface AgentModDiagnostic {
  code: string; // 见下表
  message: string; // 可读中文
  path?: string; // 如 'contributes.tools' / 'engines.velaros'
  modId?: string;
  origin?: string; // pack 目录或 bundled 标识
}
```

### 诊断码全表

| 码                                  | 阶段         | 意思                                                          |
| ----------------------------------- | ------------ | ------------------------------------------------------------- |
| `mod.pack-disabled`                 | discover     | 用户停用了这个 pack，本次不装载                               |
| `mod.pack-not-agent-axis`           | discover     | `provides` 不含 `velaros.agent`                               |
| `mod.pack-unreadable`               | discover     | `velaros.mod.json` 读不出来                                   |
| `mod.pack-no-agent-section`         | discover     | 文件在，但没有 `agent` 节                                     |
| `mod.pack-bindings-unloadable`      | discover     | 运行态绑定装载抛错                                            |
| `mod.envelope-invalid`              | 信封解析     | 分节形状或 `module` 节非法                                    |
| `mod.envelope-id-mismatch`          | 信封解析     | `module.id` ≠ `agent.id`                                      |
| `mod.manifest-is-envelope`          | agent 节解析 | 把整份信封当 agent 节喂进来了；先取 `envelope.agent`          |
| `mod.manifest-invalid`              | agent 节解析 | zod 校验失败（未知字段 / 非法枚举 / 缺必填）                  |
| `mod.duplicate-contribution`        | agent 节解析 | 同一 mod 同一轴内主键重复                                     |
| `mod.required-axis-not-contributed` | agent 节解析 | `requiredAxes` 列了自己没贡献条目的轴                         |
| `mod.trust-not-allowed`             | validate     | 信任级不在宿主允许集合内                                      |
| `mod.engine-incompatible`           | validate     | `engines.velaros` / `.agent` / `.shell` 不兼容                |
| `mod.required-axis-unsupported`     | validate     | 硬需求轴在本宿主无落点 → 拒载                                 |
| `mod.binding-not-allowed`           | validate     | 纯数据轴带了运行态绑定                                        |
| `mod.binding-missing`               | validate     | 需要绑定的条目没绑定（或 promptSegment 既无 `text` 又无绑定） |
| `mod.duplicate-id`                  | resolve      | mod id 已被装载；平铺加载不接受同 id 覆盖                     |
| `mod.tool-name-conflict`            | resolve      | 工具名与别的 mod 撞了（工具名全宿主唯一）                     |
| `mod.contribution-conflict`         | resolve      | 其他轴的主键与别的 mod 撞了                                   |
| `mod.axis-absent`                   | activate     | 某轴无落点，以 partial 态激活                                 |
| `mod.deactivated`                   | deactivate   | 已停用，数据按孤儿保全语义保留                                |
| `mod.seam-handler-failed`           | 运行期       | 某个钩子抛异常，被隔离成诊断并跳过                            |
| `mod.seam-sync-contract-violation`  | 运行期       | 同步 seam 的钩子返回了 Promise，本次结果被忽略                |

---

## 五、宿主侧接法（写宿主的人看）

```ts
import {
  assembleAgentMods,
  type AgentModHostProfile,
  type AgentModPackDescriptorLike,
  type AgentModPackReader,
  projectAgentModTools,
  projectAgentModPromptSegments,
} from "@velaros-ai/agent";

const host: AgentModHostProfile = {
  hostId: "desktop",
  velarosVersion: "0.3.0", // 对 engines.velaros
  agentApiVersion: "1.0.0", // 对 engines.agent
  shellId: "desktop", // headless 宿主不声明
  shellVersion: app.getVersion(),
  supportedAxes: [
    "tools",
    "toolCategories",
    "promptSegments",
    "skills",
    "spaces",
    "subAgentTypes",
    "turnContextSources",
    "executionModes",
    "hooks",
  ],
  allowedTrustLevels: ["bundled-official"], // 缺省即此值（fail-closed）
};

const { loader, report } = await assembleAgentMods({
  host,
  // bundled 缺省 = [createBuiltinAgentModPackage()]，官方内置恒加载
  packs, // AgentModPackDescriptorLike[]，结构鸭子类型即可
  reader, // 宿主实现 IO
});

const snapshot = loader.registry.snapshot();
const tools = projectAgentModTools(snapshot);
const segments = projectAgentModPromptSegments(snapshot);
```

`AgentModPackReader` 是 IO 端口，主干零文件系统依赖：

```ts
interface AgentModPackReader {
  readManifest(input: {
    packDirectory: string;
    manifestFileName: string;
    descriptor: AgentModPackDescriptorLike;
  }): Promise<unknown> | unknown; // 返回整份信封，取 agent 节是主干的事
  loadBindings?(input: {
    packDirectory: string;
    manifest: unknown; // 整份信封（可能要用 module 节的寻址字段）
    descriptor: AgentModPackDescriptorLike;
  }): Promise<AgentModBindings | undefined> | AgentModBindings | undefined;
}
```

消费快照的纪律（pi 吸收规则）：

- **显式注入**：贡献只经 Loader 写入，运行链一律读 `snapshot()`，没有「拿到 registry 就地改」的通路；
- **每回合固定 generation 快照**：同一 generation 内 `snapshot()` 复用同一冻结对象；
- **两阶段**：写入只在 registration 阶段，运行阶段写入即抛；
- **stale-reject**：`registry.isStale(snapshot)` / `registry.assertFresh(snapshot)`，
  generation 推进后旧快照判失效，抛 `AgentModStaleSnapshotError`，**绝不静默回退到旧值**。

---

## 六、宿主兼容性（先读这条）

manifest 能通过解析，不代表每个产品宿主都支持全部行为。作者在发布前必须核对目标宿主公开的
`AgentModHostProfile`：

1. `allowedTrustLevels` 是否允许 pack 的信任级；
2. `supportedAxes` 是否包含所需贡献轴；
3. pack reader 是否为 `tools` 和 `hooks` 提供运行态绑定；
4. 目标宿主实际派发哪些 seam kind；
5. UI 声明是否属于该宿主公开支持的产品协议。

Platform 自带 `velaros.agent.builtin`，并让它经过与外部 pack 相同的
validate → resolve → activate 管线。它验证装载机制，不代表任何具体产品宿主的全部兼容范围。
