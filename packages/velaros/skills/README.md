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

模型通过 `velaros:skills` 的 guide、list、load、validate、install、remove 按需查询开发规范、管理本机库与读取本轮选中 Skill。开发文档和示例随包发布。默认 acquire() 返回空 Skill 环境，宿主显式传入名称、安装代次与本轮能力授权；安装内容与会话加载分别管理。
