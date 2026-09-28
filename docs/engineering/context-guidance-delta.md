# 上下文装配差量

日期：2026-09-28。

## 当前请求

Desktop 每帧通过 `runtime.environment` 提供：

```json
{
  "os": "macOS 26.3.1 (arm64)",
  "shell": "/bin/zsh",
  "home": "/Users/example",
  "cwd": "/Users/example/project",
  "workspace": "project; paths confined to cwd",
  "time": "2026-09-28T12:00:00+08:00",
  "localTime": "2026-09-28 12:00:00 Monday",
  "timezone": "Asia/Shanghai"
}
```

跨会话记忆按需进入执行结果：

```js
import { output } from 'velaros';
import { memory } from 'velaros:system';
output(await memory.recall({ query: '发布流程', limit: 5 }));
```

## 合同与验收

公开 API、类型声明、执行协议、能力权限保持现有合同。运行说明使用短说明和调用示例；标准库与常驻模块仍附完整声明和现有模板。Desktop 开场仅绑定长期记忆作用域，读取由 `memory.recall` 发起；当前任务工作笔记沿用驻留设置。

验收覆盖：真实模型请求中的环境、不同作用域的记忆隔离、新会话首帧、显式召回、常驻模块完整类型、前缀缓存与请求预算。`host-instructions.test.mjs` 验证 Platform；Desktop 的 `runtime.test.mjs` 与 `MemoryService.test.ts` 验证接入。
