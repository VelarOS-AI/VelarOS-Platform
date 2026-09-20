# Velaros 装配不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 模块发现、脚本调用、上下文提交和重启恢复复用共享主干 | 测试 | test/runtime.test.mjs |
| INV-2 | 模型入口为 script；observe/execute 字段共用提交校验，内部模块及持久源码分页读取共用注册表 | 测试 | test/runtime.test.mjs |
| INV-3 | 基础契约超窗明确阻塞，截断响应不执行 | 测试 | test/runtime.test.mjs |
| INV-4 | 12 个生成领域合同与 94 个操作复用同一注册、声明、schema 和调用链 | 测试 | test/platform.test.mjs |
| INV-5 | 自动保存脚本可在重启后按当前会话引用执行，源码版本与执行身份分别记录 | 测试 | test/platform.test.mjs |
| INV-6 | 当前投影包含有效观察、结果租约与分别记录的源码/输出变化 | 测试 | test/platform.test.mjs |
| INV-7 | 真实图像持久保存并以图像块经共享编译器发送 | 测试 | test/platform.test.mjs、test/provider.test.ts |
| INV-8 | 精确编辑全成或全不成，检查失败保存可修复草稿，旧观察基线不得覆盖新版本 | 测试 | test/incremental-edit.test.mjs |
| INV-9 | 同次提交全部候选先检查，源码、观察更新和执行占位原子提交；重试不重复执行，未决状态要求核对 | 测试 | test/incremental-edit.test.mjs |
| INV-10 | 结果租约按已接受的模型回合消费，分页读取与续租不会重新执行原脚本 | 测试 | test/program-context.test.mjs |
| INV-11 | 观察增量编辑默认绑定本轮展示版本；合并提交检查失败不改变观察或执行世界操作 | 测试 | test/script-submission.test.mjs |
