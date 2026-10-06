# Skills

Skill 是 Node Agent Runtime 的安装和扩展单元，可以提供标准 npm 依赖、按需说明、脚本资源和授权宿主能力。

## 用法

```ts
import { createSkillRegistry, type SkillRegistryOptions } from '@velaros-ai/velaros/skills'

async function openEnvironment(options: SkillRegistryOptions) {
  const skills = createSkillRegistry(options)
  const lease = await skills.acquire()
  try {
    return lease.environment
  } finally {
    await lease.release()
  }
}
```

## 入口

- `@velaros-ai/velaros/skills`：安装、授权和会话环境租约。
- `@velaros-ai/velaros/skills/contracts`：可移植的 Skill 包、安装请求与收据描述。

## 约定

标准依赖使用 package.json 的 dependencies，公开给 Agent 的包名在 agentSkill.packages 声明。说明入口为可选的 agentSkill.instructions。纯 SKILL.md 目录安装时生成清单。宿主在独立暂存目录完成依赖安装，随后内容验证与原子发布；原有会话持有的租约保护它使用的安装版本。
