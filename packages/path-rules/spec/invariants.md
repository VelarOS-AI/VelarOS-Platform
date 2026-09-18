# 路径规则公共件不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | glob 规则按三种写法解释：`/` 结尾按目录前缀、不含通配按精确或目录前缀、其余交给 picomatch（点开头的文件也匹配）；缺省区分大小写，`caseSensitive: false` 时大小写变体一样命中 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | .gitignore 的判定跟 git 一致：锚定里的通配（`/build*`）、含 `/` 的规则（`docs/*.md`）、`**`、字符类（`[Dd]ist`）、转义的尾随空格都认；同一批规则后面的覆盖前面的，反向规则把路径捞回来 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 以 `/` 结尾的规则只匹配目录：同名的文件不算命中，目录里的东西照样连带命中 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 上级目录被忽略时，它下面的一切跟着被忽略——不论深几层、也不论规则写在哪一级 .gitignore 里 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 有注入的 git 执行口时以 git 的结论为准；执行口返回 null（git 不在、跑不起来）之后不再问它，改按本地 .gitignore 规则判，结论照样给得出来 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 规则根自己永远不跳过；`rulesFrom: 'repository'` 时不在版本库里、或者搜索根自己就被忽略，整次遍历什么都不跳；`unrestricted` 一律不跳 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
