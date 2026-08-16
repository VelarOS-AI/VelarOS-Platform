# 产品宿主协议：`ui.settings`

`ui.settings` 是声明式设置 DSL 的建议形状，属于产品宿主的 `ui` 节，不属于
`@velaros-ai/agent` 的九个贡献轴。Platform 不导出通用解析器，也不承诺所有宿主支持该字段。

目标宿主若采用此协议，必须在自己的公开文档中说明 schema 版本、字段闭集、存储、权限、渲染和
迁移行为。作者不能仅凭本页判断某个产品已经支持它。

## 建议形状

```jsonc
{
  "ui": {
    "settings": {
      "groups": [
        {
          "id": "acme.notes.general",
          "title": "Notes",
          "description": "Configure note retrieval.",
          "domain": "extensions",
          "order": 100,
          "fields": [
            { "key": "autoIndex", "type": "toggle", "label": "Auto index", "default": true },
            {
              "key": "depth",
              "type": "number",
              "label": "Maximum depth",
              "default": 3,
              "min": 1,
              "max": 10,
              "step": 1
            },
            {
              "key": "engine",
              "type": "select",
              "label": "Search engine",
              "default": "fts",
              "options": [
                { "value": "fts", "label": "Full-text search" },
                { "value": "semantic", "label": "Semantic search" }
              ]
            },
            {
              "key": "excludeGlob",
              "type": "text",
              "label": "Exclude",
              "default": "",
              "placeholder": "**/node_modules/**",
              "maxLength": 200
            }
          ]
        }
      ]
    }
  }
}
```

建议的字段闭集是 `toggle`、`select`、`text` 和 `number`。字段公共属性为
`key`、`label` 和可选的 `description`。`select` 需要稳定的 option value；`number` 的边界和步长
必须由宿主在写入时再次验证，不能只依赖界面控件。

## 必须保持的产品语义

采用此协议的宿主应遵守：

1. **装了才出现**：只展示已激活 pack 的设置贡献；
2. **停用不清值**：停用或卸载默认保留命名空间中的值；
3. **显式清理**：删除用户数据需要独立确认；
4. **按领域组织**：普通用户界面按功能领域展示，并标注贡献来源；
5. **命名空间隔离**：值存入 `mods.<modId>.<key>` 或等价的 per-mod 分片；
6. **宽容展示、严格写入**：坏字段可被跳过并留下诊断，非法值不能写入存储；
7. **权限不提升**：设置值不能扩大 manifest 权限或绕过 capability broker。

自定义组件和可执行渲染器不属于此纯数据 DSL。若宿主另行支持它们，必须使用更高信任级、隔离
运行环境和单独的安全审查。
