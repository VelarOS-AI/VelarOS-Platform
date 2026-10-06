# 示例：guided-review

这是一个可直接使用的代码审查 Skill，说明 Agent 如何从实际变更中定位问题并给出证据。它只需要说明，使用基础 Node、Execa 和项目中已有的工具。

guide({topic:'example'}) 的 files 包含完整 SKILL.md。用 Node 写入新目录后即可校验和安装：

```js
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {guide,validate,install} from 'velaros:skills';
const example = await guide({topic:'example'});
const directory = './guided-review';
await mkdir(directory); // 新目录，避免覆盖已有作品
for (const [path,content] of Object.entries(example.files)) {
  await writeFile(join(directory,path),content,{flag:'wx'});
}
console.log(await validate({directory}));
console.log(await install({directory}));
```

在聊天框「+」选择示例并发送后，调用 load({name:'guided-review'}) 读取说明。也可以把目录交给设置页安装。
