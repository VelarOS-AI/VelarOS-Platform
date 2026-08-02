# 轴：`spaces` —— 空间组合规则

空间是 Mod Loader 装配能力的产品面。它声明会话身份、职责包、常驻工具和每回合上下文，
但不实现文件、浏览器或系统操作。具体行为必须由单一职责包贡献，再由空间配方组合。

`@velaros-ai` 是最外层品牌 scope；Project、System、Browser、Game 等是品牌下的聚合语言，
职责通过包的子入口暴露。不要为每个空间复制一套读写、执行或代码理解实现。

## 声明契约

`AgentModSpaceContributionSchema` 的核心字段如下：

```ts
{
  id: string
  descriptor: {
    label: string
    hint?: string
    startTitle?: string
    order?: number
    localeKey?: string
  }
  iconId?: string
  identityStrategy: 'ordinal' | 'path' | 'origin'
  surfaceProfileId?: string
  boundCapabilityIds?: string[]
  inheritsSpaceIds?: string[]
  toolCategoryIds?: string[]
  residentToolNames?: string[]
  turnContextSourceIds?: string[]
  promptSegmentIds?: string[]
}
```

主键是 `id`。声明是纯数据，不接受组件、函数或宿主实例。

- `identityStrategy` 定义会话目标：`ordinal` 每次独立，`path` 按路径复用，`origin` 按站点复用。
- `boundCapabilityIds` 声明空间依赖的重运行时能力。
- `inheritsSpaceIds` 复用另一个空间已经拼好的职责配方，不复制工具和代码。
- `toolCategoryIds` 和 `residentToolNames` 决定可发现及常驻工具。
- `turnContextSourceIds` 是上下文源进入当前空间回合的白名单。

## 内置组合

| 空间 | Mod | 身份 | 职责组合 |
| --- | --- | --- | --- |
| System | `velaros.system` | `ordinal` | 系统文件、执行、进程、桌面 |
| Project | `velaros.project` | `path` | 项目文件、原子变更、项目执行 |
| Browser | `velaros.browser` | `origin` | 浏览器会话、观察、交互与页面数据 |
| Game | `velaros.game` | `path` | 继承 Project，再增加游戏编辑、运行和观察 |

Project 的职责类别是 `project-files`、`project-changes`、`project-execution`。
Development 不是一个重复的项目空间，而是可组合进 Project 的代码理解职责包，只贡献
`development:query-code`。Game 通过 `inheritsSpaceIds: ['project']` 获得 Project 基础能力。

## 工具身份

模型工具统一使用 `namespace:tool` 作为 canonical id，例如：

```text
project:read
system:processes
browser:observe
development:query-code
```

不支持冒号的 Provider 可以在传输边界映射成 `namespace__tool`，但注册表、权限、历史、审批、
工具结果和 Mod 声明始终保存 canonical id。空间代码不得自行维护别名表。

## 新空间检查表

1. 为新空间选择唯一 `id` 和正确的身份策略。
2. 优先继承或组合现有职责包，只实现真正新增的领域能力。
3. 为新增工具分配独立 namespace，并使用 canonical id。
4. 所有类别、工具、上下文源和 prompt 引用都必须由已启用 Mod 贡献。
5. 需要重运行时的能力写入 `boundCapabilityIds`，不把实例塞进 manifest。
6. 空间只描述组合，不承载宿主 IPC、持久化实现或产品特判。
