# 接入一个脚本能力

宿主提供 `OperationModuleDefinition`，把 schema、效果和处理器登记在同一个操作表。以下定义可被脚本以 `example:hello` 发现：

```ts
import type { OperationModuleDefinition } from '@velaros-ai/kernel'

const hello: OperationModuleDefinition = {
  binding: {
    moduleId: 'example:hello', instanceId: 'local',
    generation: 1, schemaRevision: '1',
  },
  summary: '返回问候文本',
  template: "import {output} from 'velaros'; import {greet} from 'example:hello'; output(await greet('世界'));",
  operations: {
    greet: {
      summary: '根据名字返回问候',
      input: {type: 'string'}, output: {type: 'string'}, effects: 'none',
      run: input => `你好，${input}`,
    },
  },
}
```

正式宿主通过 `createRuntime({ dataDir, modules: [hello], model })` 装配，其中 model 为宿主选择的 ModelDriver 或模型配置，dataDir 为持久状态目录。调用 `runtime.openSession(sessionId)`，再迭代 `session.submit(...)` 推进任务；结束时 `await runtime.close()`。

模型脚本按当前目录使用能力：

```js
import {output} from 'velaros';
import {greet} from 'example:hello';
output(await greet('世界'));
```

对于仓库已有的领域类，使用 `createCapabilityModule` 复用随包生成的 surface 和 implementation；领域上下文通过 requires 中的 context 回调注入。源码统一使用 contract/types/impl/utils，生成合同和模板与实际定义同步。

需要 `.velarmod` 分发时，另按 [包格式](package-format-v1.md) 提供 Kernel 模块定义及清单。Kernel 装载合同与上述脚本操作定义分别由其调用方消费，宿主负责把加载结果接到 Runtime。

验证包括 schema 合法性、发现内容、权限拒绝、observe/execute 效果、取消收束和回执恢复。正式模块的说明在模块根目录的 README.md，验收登记在 spec/invariants.md，运行 `bun run check:module-ownership`。
