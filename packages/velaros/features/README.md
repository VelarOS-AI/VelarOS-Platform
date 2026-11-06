# Features

Feature 提供产品能力的发现、加载与管理合同，安装分发及工作区身份由产品宿主绑定。Skill 是能力内部的按需操作知识，npm 与模块由执行环境装配。

## 用法

```ts
import { featuresOperations, type FeaturesOperationContext } from '@velaros-ai/velaros/features'

async function discover(context: FeaturesOperationContext) {
  return featuresOperations.list(context)
}
```

## 入口

- `@velaros-ai/velaros/features`：宿主端口、模型操作和生成合同。
- `@velaros-ai/velaros/features/contracts`：能力定义、状态、选择和加载结果。

## 约定

管理写入复用宿主确认及 Kernel 效果回执。产品宿主只提供本轮允许的加载范围，来源正文不提升授权。依赖安装及后台任务继续使用固定环境和租约。
