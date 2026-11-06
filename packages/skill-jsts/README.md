# JS/TS Skill

JS/TS 项目的标准 npm 工具与按需工作说明。通过 Skill 注册表选择后使用原包 API，依赖版本由 package.json 与安装锁文件固定。

## 用法

按需加载或在项目会话中选择 JS/TS 能力，然后从下一次程序执行起直接导入 `typescript`、`ts-morph`、`prettier`、`jsonc-parser`、`@ast-grep/napi` 或 `@playwright/test`。基础任务环境不提供 TypeScript 编译器和 ts-morph；工作区已有依赖仍优先。

## 入口

`package.json` 声明 Skill 贡献；`SKILL.md` 提供按需说明。
