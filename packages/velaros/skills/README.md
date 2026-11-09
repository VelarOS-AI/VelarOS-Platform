# Skills

Skill 环境适配器持有固定 npm 依赖、说明资源与授权租约。产品侧的安装、管理和任务选择使用 Feature；内部适配包继续沿用本单元的不可变安装与回收机制。

## 用法

```ts
import { createSkillRegistry, type SkillRegistryOptions } from '@velaros-ai/velaros/skills'

async function openEnvironment(options: SkillRegistryOptions) {
  const skills = createSkillRegistry(options)
  const installed = await skills.list()
  const lease = await skills.acquire(installed.map((skill) => ({
    name: skill.manifest.name, generation: skill.generation, grants: [],
  })))
  try {
    return lease.environment
  } finally {
    await lease.release()
  }
}
```

## 入口

- `@velaros-ai/velaros/skills`：安装、静态校验、变更订阅、按会话选择的环境租约和能力模块装配。
- `@velaros-ai/velaros/skills/contracts`：可移植的包、安装和选择描述。

## 约定

标准依赖使用 package.json 的 dependencies，公开给 Agent 的包名在 agentSkill.packages 声明。说明入口为可选的 agentSkill.instructions。纯 SKILL.md 目录安装时生成清单。宿主在独立暂存目录完成依赖安装，随后内容验证与原子发布；原有会话持有的租约保护它使用的安装版本。

标准 npm 安装器在首次安装与锁文件恢复时都复制 `file:` 依赖，不创建指向暂存位置的链接。环境发布移动目录后，依赖仍属于该不可变安装版本，不要求产品宿主改写 npm 进程环境。

宿主用 `createSkillSession({ registry, selection })` 启用按需加载，将同一个 session 传入能力装配，并以其 `acquireRuntime` 提供每次 Node 执行的固定快照。selection 只预加载默认项与显式选择；其他已安装项经 session.catalog 发现、activate 加载。执行与后台任务全部收束后释放 session；固定授权宿主仍可使用 `registry.acquire()`。产品管理、开发说明与模型按需加载由 `velaros:features` 提供。

内置 browser 与专项 jsts 共用目录、发现、租约和授权。项目事务与代码查询由宿主根据项目根装配。hostCapabilities 声明宿主能力。产品用 `skillCapabilityModules.create` 显式绑定当前资源，把返回模块交给 Runtime 的 `modules`；缺少资源时显式失败。按需加载的产品同时通过 `moduleAccess` 按同一 Skill 会话的 catalog 与活动授权控制发现和派发。标准 npm 包的 API、README 和类型保持原样，Skill 正文按任务需要读取。
