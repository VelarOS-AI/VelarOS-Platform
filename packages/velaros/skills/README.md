# Skills

Skill 是 Node Agent Runtime 的安装和扩展单元，可以提供标准 npm 依赖、按需说明、脚本资源和授权宿主能力。

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

- `@velaros-ai/velaros/skills`：安装、静态校验、变更订阅、按会话选择的环境租约和模型操作实现。
- `@velaros-ai/velaros/skills/contracts`：可移植的包、安装和选择描述，以及 velaros:skills 生成合同。

## 约定

标准依赖使用 package.json 的 dependencies，公开给 Agent 的包名在 agentSkill.packages 声明。说明入口为可选的 agentSkill.instructions。纯 SKILL.md 目录安装时生成清单。宿主在独立暂存目录完成依赖安装，随后内容验证与原子发布；原有会话持有的租约保护它使用的安装版本。

模型通过 `velaros:skills` 的 guide、list、load、validate、install、remove 查询规范、管理本机库与读取说明。宿主用 `createSkillSession({ registry, selection })` 启用按需加载，将同一个 session 传入模型操作上下文和能力装配，并以其 `acquireRuntime` 提供每次 Node 执行的快照。selection 只预加载工作区默认项与显式选择；其他已安装 Skill 由模型按需加载，不要求用户勾选。执行与后台任务全部收束后释放 session。固定授权宿主仍可使用 `registry.acquire()`。

内置 browser 与专项 jsts 共用目录、发现、租约和授权。项目事务与代码查询由宿主根据项目根装配。hostCapabilities 声明宿主能力，当前资源绑定经 createRuntime 的 skills 装配；缺少资源时显式失败。标准 npm 包的 API、README 和类型保持原样，Skill 正文只在 load 时读取。

宿主通过 plugins 端口提供完整插件中的内部 Skill，并订阅安装、启停与版本变更。插件代次参与 Skill 身份，防止插件运行资源更新后沿用旧授权；内部 Skill 的安装和删除交给所属插件。注册本身只更新目录，模型经 `load({ name })` 按需读取说明；多个相关 Skill 可用 `Promise.all` 一起查询。新安装代次从下一轮进入发现目录。
