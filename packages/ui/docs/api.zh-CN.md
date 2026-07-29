# `@velaros-ai/ui` 中文 API

## 定位与非目标

本包提供可组合的 React 19 UI 原语、应用壳组件、设计令牌和组件样式。组件只拥有自身交互状态，
不读取 Electron IPC、路由、业务 Store、Kernel 或任意宿主单例，因此可用于普通 Web 应用、
Electron、WebView 和独立组件预览。

本包不负责聊天协议、Agent 状态、数据持久化和业务流程。带有 `product` 名称的组件仍然只是有明确
视觉语义的组合件，不包含 VelarOS Desktop 数据模型。

## 安装

```bash
npm install @velaros-ai/ui react react-dom
```

```tsx
import { Button, Stack } from '@velaros-ai/ui'
import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
```

## 公共入口

- `@velaros-ai/ui`：全部稳定 React 组件、Hook 和类型。
- `@velaros-ai/ui/primitives/**`：单组件按需入口。
- `@velaros-ai/ui/product/**`：产品级无状态组合件。
- `@velaros-ai/ui/hooks/usePointerResize`：拖拽尺寸控制。
- `@velaros-ai/ui/lib/cn`、`@velaros-ai/ui/lib/styleUtils`：通用样式辅助。
- `@velaros-ai/ui/utility-types`：`Nullable`、`LooseOptional` 等纯模块类型。
- `@velaros-ai/ui/styles/**`：设计令牌与组件 CSS。

只有 `package.json#exports` 声明的路径属于公共 API。禁止导入 `src` 或 `dist` 内部路径。
发布声明不会安装 ambient global；需要辅助类型时使用 `utility-types` 显式模块入口。

## 核心类与接口

UI 组件使用 React 函数组件，因为它们是声明式视图而不是领域对象。`RenderErrorBoundary` 是 React
错误边界，按 React 生命周期要求使用 class。计时器等拥有资源生命周期的内部实现使用对象封装。

公共组件的 Props 类型与组件一起导出。例如：

```tsx
import { type ButtonProps, Button } from '@velaros-ai/ui'

const SaveButton = (props: Pick<ButtonProps, 'disabled'>) => (
  <Button variant="primary" {...props}>保存</Button>
)
```

组件形态由 `variant`、`size`、`tone` 等有限枚举表达。宿主通过子元素、回调和语义属性组合行为，
无需把业务对象转换成库内 DTO。

## 生命周期/并发

大多数组件没有跨挂载生命周期。带浮层、拖拽、定时器或观察器的组件在卸载时释放监听器与任务。
异步业务请求由宿主拥有；组件只报告用户意图，不私自启动全局任务。

## 依赖注入

- 文案通过 `UiLocalizationProvider` 注入。
- 行为通过 `onClick`、`onChange`、`onOpenChange` 等回调注入。
- 主题通过 CSS 自定义属性和 `data-theme` / `data-velar-preset` 注入。
- 图标、内容和操作区通过明确的 React 节点槽位组合。

组件不会读取 Desktop IPC、全局 Store 或某个路由器。

## 错误模型

受控组件将校验和业务错误作为 Props 展示；不会吞掉宿主回调异常。`RenderErrorBoundary` 仅用于宿主
明确选择隔离渲染失败的区域。类型错误在 TypeScript 编译期暴露，无统一的运行时 Result 包装。

## 最小第三方示例

```tsx
import { Card, Input, Stack, Button } from '@velaros-ai/ui'
import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'

export function ProfileForm() {
  return (
    <Card>
      <Stack gap="md">
        <Input aria-label="姓名" placeholder="请输入姓名" />
        <Button variant="primary">保存</Button>
      </Stack>
    </Card>
  )
}
```

## 扩展点

- 使用设计令牌覆盖品牌色、间距、圆角和主题。
- 用有限 Props 与子元素组合新的业务组件。
- 通用、跨应用且无业务状态的组件可进入 `primitives`。
- 具有稳定产品视觉语义、但仍不依赖宿主数据的组合件可进入 `product`。

无状态格式化和 class 合并保持为纯函数；组件与资源控制器不做相互转换。

## 兼容策略

根入口与显式子路径遵循语义化版本。新增组件可以向后兼容发布；删除入口、修改 Props 语义或设计
令牌含义需要主版本。未导出的源码文件可以在不承诺兼容的情况下调整。
