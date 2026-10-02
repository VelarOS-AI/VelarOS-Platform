# 模板查询入口收敛差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

## 当前合同

模型统一通过 `velaros:system` 的 `modules.describe({module, export?})` 读取模块 schema、声明与模板。系统成员用 `export` 选择，业务模块直接使用其模块名。查询经过已有 Kernel 操作、宿主授权和会话能力范围检查；返回的 `template` 是实际注册模块的示例源码。

```js
import {output} from 'velaros';
import {modules} from 'velaros:system';
const info = await modules.describe({module: 'velaros:system', exports: ['memory']});
output(info.template);
```

业务模块的写法为 `modules.describe({module: 'velaros:files'})`。读取只返回模板文本；模型根据任务选用源码，提交脚本时才会执行。程序数据模块 `velaros:program` 提供本次 `input` 与 `blobs`。

## 对外契约与迁移

用户要求模板查询只保留一个入口。原 `velaros:program.template()` 和 `modules.describe(...).template` 重复，且正式 KernelScriptSession 没有提供前者依赖的模板注入数据。模板发现由系统目录负责，运行器只接收运行数据和能力桥。

| 契约或文件 | 本次变化与影响 |
| --- | --- |
| `packages/script/src/utils/compiler.ts` | 移除 ProgramModuleDeclarations 的 template 导出；旧命名导入在执行前返回 TS2305。调用方改为 modules.describe 并读取返回的 template。 |
| `CodeSurfaceSessionApi.submit`，位于 `packages/script/src/impl/CodeSurfaceSession.ts` | 移除公开可选参数 templates 及向运行器转发；宿主把模板保存在模块注册信息中。 |
| `CodeRunRequest`，位于 `packages/script/src/types/runner.ts` | 移除 templates 字段；自定义 CodeRunnerApi 实现按当前请求合同消费数据。 |
| `packages/script/src/impl/NodeSubprocessCodeRunner.ts`、`packages/script/bin/script-child.mjs` | 清理 IPC 和 QuickJS 初始化中的模板传输及 helper。运行时的 program 导出与声明一致，只含 input/blobs。 |
| `modules.describe`，位于 `packages/velaros/act/system/impl/ModulesModule.ts` | 复用已有操作及授权目录，承担统一模板查询；输入与返回合同保持原状。 |
| 文档与生成器说明 | 更新 Script README、系统模块卡片、架构说明、script-design、声明生成器注释，以及 files/shell/sandbox/images/project/computer/office 的模板访问路径说明。 |

业务模块的 template 文件、注册表 template 字段、声明生成规则使用现有实现。历史脚本中的旧导入需要显式编辑后再次提交。

## 验收承诺调整

Script INV-27 原来保证独立 template helper 按模块名读模板，与本次单入口要求冲突。现在验证程序数据声明与运行时导出一致、input/blobs 原文和冻结边界，以及旧导入在运行器启动前被拒绝。模板按需读取、实际内容、查询不触发业务执行、宿主授权拒绝和隐藏模块的边界由系统 INV-3、INV-7 验证。七个领域模块仅调整模板查询路径文字，原有模板类型与实跑承诺继续适用。

## 本轮验证

- Script 构建通过；Script 与 Velaros 类型检查通过。
- `bun test packages/script/spec/acceptance.test.ts packages/script/test/script.test.ts packages/script/test/output.test.ts`：74 项通过。
- 系统 `spec/*.test.mjs`，以及 Runtime 的 `script-submission`、`incremental-edit`、`text-runtime`、`platform` 五组集成测试：78 项通过。覆盖实际 QuickJS、模板读取和权限、长期记忆、增量脚本、租约、异步执行、恢复、图片及 input/blobs。
- `check:module-ownership`、`check:agent-schemas`、`check:agent-arch`、`check:capabilities-arch`、`check:act-catalog` 通过。
- `check:script` 通过：2 项生成器测试，以及 12 个模块声明与源码一致性检查。
- `node --check packages/script/bin/script-child.mjs` 与本轮涉及文件的 `git diff --check` 通过。

本轮使用确定性模型替身，真实模型评测按用户安排后续进行。
