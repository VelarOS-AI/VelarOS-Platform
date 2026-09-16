# @velaros-ai/path-rules

路径命中规则，system 空间、project 空间共用一份：

- `pathMatcher.matchesAny(path, patterns, options?)`：glob 匹配。`/` 结尾按目录前缀；不含通配按精确或目录前缀；其余交给 picomatch（点开头的文件也匹配）。缺省区分大小写，大小写不敏感的盘上按路径身份判定时传 `caseSensitive: false`。
- `gitignoreRules.parse / readRules / readAncestorRules / isIgnored`：.gitignore 的解析与判定。取反、锚定、目录限定（`build/` 只匹配目录）、`**`、字符类、转义都认；目录被忽略时它下面的一切跟着被忽略。
- `createIgnorePolicy(root, options)`：遍历时某个条目要不要跳过。有注入的 `gitCheckIgnore` 执行口就先问 git（`git check-ignore --no-index --stdin -z`，一批一次），问不到再按各级 .gitignore 判；`rulesFrom: 'repository'` 时先往上找版本库根。
- `DiscoverySkippedDirectoryNames`：遍历与搜索默认跳过的 23 个目录名（版本库、依赖、虚拟环境、构建产物、缓存、编辑器配置），从 `./contracts` 取。

本包不起子进程、不判断路径能不能碰：起不起 git 由调用方注入执行口，根内约束、拒读拒写名单、敏感路径审批都是各空间自己的事。
根入口给 Node 宿主；`./contracts` 只有常量与可移植数据类型，浏览器和渲染进程也能加载。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)。
