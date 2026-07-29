# @velaros-ai/workspace 1.0 交接文档

> 状态时间：2026-05-29
> 当前定位：1.0 发布前稳定化完成，核心门禁通过，可进入最终代码审查 / 打包发布准备。

## 1. 当前结论

`@velaros-ai/workspace` 目前已经从“功能能跑”推进到“模型入口可控、工具契约冻结、黑盒链路有门禁”的 1.0 状态。

当前公开模型契约保持为：

- 16 个 workspace 工具。
- 17 个 edit operation。
- 11 个 postcondition。
- 7 个 batch kind。
- compact schema bundle 体积：`38,590 chars`，预算：`40,000 chars`。

完整 1.0 门禁已通过：

```bash
bun run scripts:run release:1.0
```

最近一次结果：

- workspace package tests：`108 pass`
- workspace eval：`1 pass`
- tool-file-boundary unit：`8 pass`
- tool-file-boundary arch gate：pass
- schema contract：`toolCount=16`，`sharedDefCount=73`，`bundleChars=38590`
- final arch-guard：`57 checks passed`

## 2. 关键入口

### Agent / MCP / Velaros

主要入口：

- `packages/capabilities/workspace/src/Workspace.tool.ts`：agent 工具 schema 与描述。
- `packages/capabilities/workspace/src/agent-tools.ts`：工具执行适配层。
- `packages/capabilities/workspace/src/tool-schema.ts`：expanded / compact JSON schema 生成。
- `packages/capabilities/workspace/src/mcp/index.ts`：MCP-like server。
- `packages/capabilities/workspace/src/velaros/index.ts`：Velaros bridge。
- `src/main/tools/collections/workspace/Kernel.tool.ts`：桌面端 VelaTool 包装。
- `src/main/tools/ToolRegistry.ts`：桌面端工具转 AI SDK ToolSet。

MCP 默认 `listTools()` 返回 compact bundle，`listExpandedTools()` 返回展开版 descriptor。Velaros bridge 当前同时保留 raw `AgentToolDefinition[]` 和 `toolSchemaBundle`；宿主如果支持 compact bundle，应优先消费 `toolSchemaBundle`，避免模型入口吃重复展开 schema。

CLI 入口仍建议作为黑盒测试 / 离线自动化 / 多进程验证入口，不建议替代 Velaros runtime 内部模型工具入口。原因是 runtime 内部已有 provider、approval、policy、context、telemetry 等集成面，CLI 更适合进程边界与真实调用覆盖。

### CLI

主要入口：

- `packages/capabilities/workspace/src/cli/runner.ts`
- `packages/capabilities/workspace/src/cli/tool-commands.ts`
- `packages/capabilities/workspace/src/cli/workspace-factory.ts`

CLI 已覆盖：

- `tools list`
- `tools call`
- `tools workflow`
- `args-file`
- `steps-file`
- target / transaction 跨进程状态持久化。
- malformed state cache 容错。

CLI 状态文件位于 `.velaros-workspace/state.json`，被 CLI 默认 policy/fileFilter 屏蔽。

## 3. 已冻结的模型契约

### 工具数量和名称

稳定工具名以 `WorkspaceKernelToolNames` 为准，当前包括：

- `ws_status`
- `ws_read`
- `ws_file_stat`
- `ws_list_files`
- `ws_search`
- `ws_symbols`
- `ws_resolve_target`
- `ws_build_evidence`
- `ws_prepare_edit`
- `ws_amend_edit`
- `ws_commit_edit`
- `ws_apply_edit`
- `ws_validate`
- `ws_rollback`
- `ws_diff`
- `ws_run_batch`

旧入口不应再对外暴露。桌面端 `Collection.ts` 只注册新 workspace 工具；旧的 `read_file/list_files` 这类别名不应恢复。

### 读取契约

`read` 只接受：

```json
{
  "paths": ["src/app.ts"],
  "range": { "startLine": 1, "endLine": 120 },
  "maxChars": 50000
}
```

规则：

- 单文件读取也必须使用 `paths` 数组。
- 默认禁止无界读取。
- 必须提供 `range.endLine`、`maxBytes`、`maxChars`，或显式 `allowUnbounded:true`。
- `baseRevisions` 是 `Record<path, revision>`，不再使用单个 `baseRevision`。
- read 的 model-facing range 只支持行号，不支持 offset。

这条约束现在同时存在于：

- Zod runtime。
- expanded JSON schema。
- compact schema bundle。
- 宿主 ToolRegistry 暴露给 AI SDK 的 JSON schema。

### 编辑操作

编辑操作已结构化为逐项 schema，不再用一个大 enum 加散文说明堆在一起。当前 17 个 operation：

- `replace_text`
- `insert_text`
- `insert_text_at_anchor`
- `append_text`
- `prepend_text`
- `delete_text`
- `create_file`
- `delete_file`
- `rename_file`
- `replace_symbol`
- `insert_around_symbol`
- `insert_before_symbol`
- `insert_after_symbol`
- `add_import`
- `remove_import`
- `json_patch`
- `custom`

架构检查已约束这类“同入口、多操作、多参数”的 schema：每个分支必须有独立结构和说明，防止模型只看到 enum 却不知道参数怎么传。

### postcondition

当前 11 个 postcondition：

- `must_contain`
- `must_not_contain`
- `must_keep_symbol`
- `must_modify_symbol`
- `must_not_modify_symbol`
- `changed_files_allowlist`
- `max_changed_lines`
- `schema_valid`
- `layout_preserved`
- `formula_preserved`
- `custom`

注意：默认 core 只直接执行文本包含、文本排除、变更文件 allowlist、最大变更行数。其余类型是给 adapter / validator / 插件声明使用，不应在描述中暗示 core 默认会全部执行。

### batch

当前 model-facing batch kind 只有：

- `read`
- `search`
- `resolve`
- `prepare`
- `apply`
- `validate`
- `rollback`

实现层类型仍有 `custom`，但 1.0 模型入口不暴露 `custom batch`。这是刻意选择，优先保证安全和可预测。

batch 依赖语义已修正：`dependsOn` 表示依赖任务必须成功完成。`stopOnError:false` 时，独立任务可以继续跑，但失败任务的 dependent 会被标记为 `DEPENDENCY_FAILED`，不会执行。

## 4. 最近完成的稳定性修复

### JSON Schema 与 Zod runtime 对齐

问题：Zod `superRefine` 不会出现在 JSON Schema 中，导致模型看到的 schema 会接受 `{ paths:["a.txt"] }`，但 runtime 拒绝。

修复：

- `packages/core/src/utils/ToolInputBounds.ts` 新增 `withReadBoundJsonSchemaConstraints`。
- `packages/capabilities/workspace/src/tool-schema.ts` 在 expanded / compact schema 生成时补上 read 边界约束。
- `src/main/tools/ToolRegistry.ts` 在 AI SDK schema 输出时补上同样约束。

覆盖：

- `bun run scripts:run check:architecture`
- `bun run typecheck`
- `packages/capabilities/workspace/test/workspace.test.mjs`

### AI SDK record schema 修复

问题：AI SDK `zodSchema()` 对 `z.record(z.string(), z.string())` 生成的 schema 会把 `additionalProperties` 弄错，影响 `baseRevisions`。

修复：

- `src/main/tools/ToolRegistry.ts` 改用 `jsonSchema(() => z.toJSONSchema(...), { validate })`，由 Zod runtime 做真实校验。

覆盖：

- `ToolRegistry preserves record schemas when exposing tools to the model`

### 大文件 read/stat 内存优化

问题：`stat()` 和部分有界 `read()` 为了算 revision 会整文件读入内存。

修复：

- `packages/capabilities/workspace/src/core/file-store.ts` 对不需要完整内容的大文件使用流式 hash + 首块二进制判断。
- `maxChars/maxBytes` 前缀读取走 `readLimitedTextPrefix`，避免整文件进内存。

注意：按 `range` 读取超大文本时，当前仍会落到完整文本读取后再 `sliceLines`。这不是 1.0 阻断项，但如果 2.0 做更强大文件能力，应把行窗口读取改成流式按行扫描。

覆盖：

- `workspace read and stat honor bounds for files above the full-read limit`

### batch 依赖语义修复

问题：`stopOnError:false` 时，失败任务的 dependent 可能继续执行。

修复：

- `packages/capabilities/workspace/src/batch/runner.ts` 维护 `failedTaskIds`。
- dependent 遇到失败依赖时返回 `DEPENDENCY_FAILED`。
- 无依赖任务仍可继续执行。

覆盖：

- `batch scheduler blocks dependents of failed tasks while continuing independent work`

## 5. 架构检查现状

`packages/arch-guard-velaros/src/checks/architecture/toolFileBoundaries.ts` 已放宽并加强：

- `.tool.ts` 仍只能保留工具定义和 schema 结构。
- 允许当前文件内保留 schema 结构。
- 禁止工具函数 / 实现逻辑散落在 `.tool.ts`。
- 禁止静态 workspace 工具名出现在描述中。
- 允许通过 `wsTool.*` 这种动态工具名引用。
- 对多操作入口强制每个操作分支结构化。

对应测试：

- `bun run scripts:run check:architecture --only velaros/tool-file-boundaries`

## 6. 当前验证命令

日常最小验证：

```bash
npm --workspace @velaros-ai/core run build
npm --workspace @velaros-ai/workspace test
bun run scripts:run check:architecture
bun run typecheck
```

1.0 发布门禁：

```bash
bun run scripts:run release:1.0
```

schema 黑盒探针可用：

```bash
bun --conditions=source - <<'EOF'
import '@velaros-ai/core/extensions'
import Ajv from 'ajv'
import { WorkspaceAgentToolSpecs } from './packages/capabilities/workspace/src/Workspace.tool.ts'
import { createWorkspaceToolSchemaBundle, schemaToInputSchema } from './packages/capabilities/workspace/src/tool-schema.ts'

const ajv = new Ajv({ strict: false, allErrors: true })
const tools = new Map(WorkspaceAgentToolSpecs.map((tool) => [tool.name, tool]))
const bundle = createWorkspaceToolSchemaBundle(WorkspaceAgentToolSpecs.map((tool) => ({
  name: tool.name,
  description: tool.description,
  schema: tool.schema,
})))

const cases = [
  ['expanded read', schemaToInputSchema(tools.get('ws_read').schema)],
  ['expanded batch', schemaToInputSchema(tools.get('ws_run_batch').schema)],
  ['compact read', { ...bundle.tools.find((tool) => tool.name === 'ws_read').inputSchema, $defs: bundle.$defs }],
  ['compact batch', { ...bundle.tools.find((tool) => tool.name === 'ws_run_batch').inputSchema, $defs: bundle.$defs }],
]

for (const [label, schema] of cases) {
  const validate = ajv.compile(schema)
  const isRead = label.includes('read') && !label.includes('batch')
  const bad = isRead
    ? { paths: ['a.txt'] }
    : { tasks: [{ id: 'r', op: { kind: 'read', input: { paths: ['a.txt'] } } }] }
  const good = isRead
    ? { paths: ['a.txt'], maxBytes: 10 }
    : { tasks: [{ id: 'r', op: { kind: 'read', input: { paths: ['a.txt'], maxBytes: 10 } } }] }
  console.log(label, 'bad=', validate(bad), 'good=', validate(good))
}
EOF
```

预期：

```text
expanded read bad= false good= true
expanded batch bad= false good= true
compact read bad= false good= true
compact batch bad= false good= true
```

## 7. 重要文件速查

核心实现：

- `packages/capabilities/workspace/src/core/workspace.ts`
- `packages/capabilities/workspace/src/core/file-store.ts`
- `packages/capabilities/workspace/src/batch/runner.ts`
- `packages/capabilities/workspace/src/patch/text-strategy.ts`
- `packages/capabilities/workspace/src/patch/jsts-strategy.ts`
- `packages/capabilities/workspace/src/patch/json-strategy.ts`

工具契约：

- `packages/capabilities/workspace/src/Workspace.tool.ts`
- `packages/capabilities/workspace/src/agent-tools.ts`
- `packages/capabilities/workspace/src/tool-schema.ts`
- `packages/capabilities/workspace/test/fixtures/workspace-tool-schema-contract.json`

桥接：

- `packages/capabilities/workspace/src/mcp/index.ts`
- `packages/capabilities/workspace/src/velaros/index.ts`
- `src/main/tools/collections/workspace/Kernel.tool.ts`
- `src/main/tools/collections/workspace/KernelTools.ts`
- `src/main/tools/ToolRegistry.ts`

测试：

- `packages/capabilities/workspace/test/workspace.test.mjs`
- `packages/capabilities/workspace/test/cli-runner.test.mjs`
- `packages/capabilities/workspace/test/production.test.mjs`
- `bun run scripts:run check:architecture`
- `bun run typecheck`

## 8. 已知剩余问题 / 非阻断优化

### compact bundle 需要宿主配合

workspace 侧已经能生成 compact bundle，并且 MCP `listTools()` 默认返回 compact bundle。但 Velaros host 如果仍把 raw `AgentToolDefinition[]` 直接作为模型工具入口，就会重新吃展开 schema。

建议：host 侧优先消费 `toolSchemaBundle`；raw tools 只作为执行映射，不作为 prompt/schema 注入源。

### range 大文件读取仍可优化

`maxBytes/maxChars` 前缀读取已经避免整文件进内存，`stat` 也已避免整文件进内存。
但 `range` 对超大文本仍会读取完整文件后切行。2.0 可改为流式按行窗口读取。

### prepare/apply 的大文件编辑仍依赖完整 snapshot

结构化编辑、符号编辑和 patch strategy 仍需要完整文本内容。1.0 保持现状；2.0 如果要支持超大文件编辑，需要引入分块 patch 或 streaming patch 策略。

### CLI workflow 失败时不返回 partial results

`tools.workflow` 当前遇到异常会走统一错误 envelope，不返回已成功步骤的 partial results。测试已覆盖正常 workflow 和错误输入。
这不是 1.0 阻断项，但如果要做更好的外部自动化体验，可以增加 `continueOnError` 或 partial result envelope。

### run_batch 暂不暴露 custom

实现层有 `custom`，模型 schema 不暴露。1.0 建议保持这个策略，避免模型任意跑宿主自定义逻辑。

## 9. 交接注意事项

1. 不要把 `editOperationSchema` 拆出去变成模型不可见的散装描述；当前结构化分支是模型能用对的关键。
2. `.tool.ts` 文件只放工具和 schema 结构，工具函数继续放外部模块。
3. 描述中不要写静态 workspace 工具名；如需引用，用动态常量。
4. 不要重新引入旧工具别名。
5. schema snapshot 更新时必须确认不是无意漂移；当前 fixture 是 1.0 契约门禁。
6. 改 `packages/core/src/utils/ToolInputBounds.ts` 后，如果 workspace 包从 dist 引用 core，需要先跑：
   ```bash
   npm --workspace @velaros-ai/core run build
   ```
7. 发布前至少跑一次：
   ```bash
   bun run scripts:run release:1.0
   ```

## 10. 下一步建议

1. 做最终人工 code review，重点看：
   - `tool-schema.ts` 的 schema 后处理是否仍符合宿主消费方式。
   - `file-store.ts` 的大文件 revision / binary 判断是否符合预期。
   - `batch/runner.ts` 的失败依赖语义是否要写进用户文档。
2. 确认 Velaros host 是否已经消费 compact bundle。
3. 将 1.0 当前变更拆成可审查提交：
   - schema contract / tool schema slimming
   - read contract / ToolRegistry JSON schema
   - file-store large-file optimization
   - batch dependency semantics
   - arch guard hardening
   - tests / golden snapshot
4. 若继续做 2.0，优先项建议是：
   - 流式 range read。
   - 持久化 transaction / recovery。
   - snapshot cache。
   - host 侧 compact bundle 接入。
