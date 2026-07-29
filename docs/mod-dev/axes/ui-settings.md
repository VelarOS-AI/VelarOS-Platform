# 轴：`ui.settings` —— 声明式设置

mod 经 `ui` 节的 `ui.settings` 贡献设置项。**声明式 DSL，由产品壳定义与解析，不进通用协议。**

> **状态：已实装（Desktop）。** 这是 `ui` 节里今天唯一真正落地的轴。
> 解析器 `parseModUiSettings`（`apps/desktop/src/main/kernel/ModUiSettings.ts`）；
> 类型契约 `packages/ipc/src/desktopModSettingsContracts.ts`。

## 三条产品语义

1. **装了才出现**：mod 的设置区只在该 mod 激活时渲染（partial-activation 感知）。
2. **停用不清值**：停用 / 卸载后设置值按 [3.7 契约](../conventions.md#一数据生命周期)
   进 orphaned-but-preserved，**不静默清**。「看不见」与「被删掉」必须是两件事。
3. **用户视图仍按功能领域组织**：mod 的设置**归入对应领域区并带来源标注**，
   不给普通用户强加「mod」心智。Mod 注册表是高级视图，不是设置页本身。

## 形状

```jsonc
{
  "ui": {
    "settings": {
      "groups": [
        {
          "id": "acme.notes.general",
          "title": "Notes",
          "description": "笔记检索行为",
          "domain": "extensions",
          "order": 100,
          "fields": [
            { "key": "autoIndex", "type": "toggle", "label": "自动索引", "default": true },
            { "key": "depth", "type": "number", "label": "递归深度",
              "default": 3, "min": 1, "max": 10, "step": 1 },
            { "key": "engine", "type": "select", "label": "检索引擎", "default": "fts",
              "options": [
                { "value": "fts", "label": "全文检索" },
                { "value": "semantic", "label": "语义检索", "description": "需要向量后端" }
              ] },
            { "key": "excludeGlob", "type": "text", "label": "排除",
              "default": "", "placeholder": "**/node_modules/**", "maxLength": 200 }
          ]
        }
      ]
    }
  }
}
```

## 类型契约

`packages/ipc/src/desktopModSettingsContracts.ts`：

```ts
export interface ModSettingsDeclaration { groups: readonly ModSettingsGroup[] }

export interface ModSettingsGroup {
  id: string
  title: string
  description?: string
  domain: ModSettingsDomain
  order: number
  fields: readonly ModSettingsField[]
}

export type ModSettingsFieldType = 'toggle' | 'select' | 'text' | 'number'
export type ModSettingValue = boolean | string | number

export type ModSettingsField =
  | ModSettingsToggleField     // { type: 'toggle';  default: boolean }
  | ModSettingsSelectField     // { type: 'select';  default: string; options: readonly ModSettingsSelectOption[] }
  | ModSettingsTextField       // { type: 'text';    default: string; placeholder?; maxLength? }
  | ModSettingsNumberField     // { type: 'number';  default: number; min?; max?; step? }

export interface ModSettingsSelectOption { value: string; label: string; description?: string }
```

四种字段共有 `{ key, label, description? }`（内部基类 `ModSettingsFieldBase`）。

### `domain`：落进哪个功能领域区

```ts
export const ModSettingsDomains = [
  'system', 'permissions', 'model', 'memory',
  'skills', 'agents', 'connectors', 'extensions',
] as const
export const DefaultModSettingsDomain: ModSettingsDomain = 'extensions'
```

不在闭集内 / 缺省 → 落 `'extensions'`。
**刻意不在集合里的三个词**：`plugins`、`tools`、`mods`——
它们要么是旧系统词汇，要么会把「mod 心智」推给普通用户。

## 解析行为（宽容边界）

`parseModUiSettings(rawUiSection): ModUiSettingsParseResult`：

```ts
interface ModUiSettingsParseResult {
  declaration: Nullable<ModSettingsDeclaration>
  diagnostics: readonly string[]
}
```

- 解析路径是 `ui.settings.groups[]`；
- 未知 `type` **不拒载整份声明**，而是跳过该字段并留诊断：
  > `不在闭集 toggle|select|text|number 内，已跳过。`
  诊断路径形如 `` ui.settings.groups[acme.notes.general].fields[2] ``；
- `order` 缺省 `DefaultGroupOrder = 1000`；
- 读取走宽容解析——缺字段 / 新字段**不把设置页 brick**。

> 注意这条与 agent 节的口径**不同**：agent 节是「未知字段即拒载」，
> `ui.settings` 是「未知字段跳过 + 诊断」。理由是失败半径不同——
> 设置页是用户可见面，一个坏字段不该让整个 mod 的设置区消失。

## 存储

配置落 **per-mod 命名空间分片**，键路径 `` mods.<modId>.<key> ``。

IPC：

| 通道 | 渲染层方法 |
| --- | --- |
| `config:get-mod-settings` | `rendererIpc.settings.getModSettings(): Promise<Result<ModSettingsValuesByMod>>` |
| `config:patch-mod-settings` | `rendererIpc.settings.patchModSettings(request: ModSettingsPatchRequest)` |

```ts
export type ModSettingsValueShard  = Readonly<Record<string, unknown>>
export type ModSettingsValuesByMod = Readonly<Record<string, ModSettingsValueShard>>
export interface ModSettingsPatchRequest {
  modId: string
  values: Readonly<Record<string, ModSettingValue>>
}
```

## 渲染档

`ui.settings` 与其他 `ui` 轴共用**同一把三档梯子**（见 [ui-shell.md](./ui-shell.md#一渲染三档信任梯)）：

- **纯数据字段 DSL = T1**——任何信任级都能用，就是本页写的东西；
- **沙箱 HTML = T2**——同样对任何信任级开放；
- **自定义渲染器 = T3**——仅 `bundled-official` / `marketplace-signed`。

设置轴**不另立一套档位**。

## 渲染层落点（Desktop）

| 文件 | 作用 |
| --- | --- |
| `renderer/src/components/settings/registry/modSettingsModel.ts` | `collectModSettingsGroupBindings(overview)` / `hasModSettingsGroups(pack)` / `resolveModSettingValue(field, raw)` / `resolveModSettingsGroupValues(group, shard)` |
| `renderer/src/components/settings/registry/modSettingsContributions.tsx` | `materializeModSettingsContributions(...)` |
| `renderer/src/components/settings/registry/ModSettingsGroupSection.tsx` | `ModSettingsGroupSection` |
| `renderer/src/hooks/settings/useModSettings.ts` | `useModSettings()` |
</content>
