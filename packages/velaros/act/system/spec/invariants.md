# 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 实际操作、模板内容和脚本声明保持一致 | 测试 | spec/acceptance.test.mjs |
| INV-2 | 系统包调用复用真实 Kernel 身份 | 测试 | spec/runtime.test.mjs |
| INV-3 | 规范目录、成员合同与模板同源 | 测试 | spec/runtime.test.mjs |
| INV-4 | 观察模式只读、工作笔记进入新帧 | 测试 | spec/runtime.test.mjs |
| INV-5 | 宿主授权与会话引用边界始终生效 | 测试 | spec/runtime.test.mjs |
| INV-6 | 租约与源码读取不会重跑脚本 | 测试 | spec/runtime.test.mjs |
| INV-7 | 发现先授权过滤后分页 | 测试 | spec/runtime.test.mjs |
| INV-8 | 系统保留身份无法被业务模块替换 | 测试 | spec/runtime.test.mjs |
| INV-9 | 未授权包成员不会进入运行器 | 测试 | spec/runtime.test.mjs |
| INV-10 | 子任务拥有独立自管理状态 | 测试 | spec/runtime.test.mjs |
| INV-11 | 系统脚本与笔记跨重启恢复 | 测试 | spec/runtime.test.mjs |
| INV-12 | 主线长期记忆复用宿主作用域与 Markdown 库，受模式和权限保护；支线合同不继承，租约回收不删除长期原文 | 测试 | spec/long-term-memory.test.mjs |
| INV-13 | store 只暴露当前授权合同，JSON 持久化、版本冲突、观察只读与宿主授权共同保护提交 | 测试 | spec/store.test.mjs |
| INV-14 | 状态变化进入真实模型帧、纳入预算并按接受帧确认，失败重启补收，思考期间新变化继续交付 | 测试 | spec/store.test.mjs |
| INV-15 | 子任务继承父任务的共享空间与读写范围，不增加递归派发能力；外部改了读过的状态不挡写入、也不打回收尾，写入各自按 baseRevision 核对 | 测试 | spec/store.test.mjs |
| INV-16 | 多空间创建与授权独立，跨空间依据不混淆、通知共用预算且轮换，子任务每次运行按父任务此刻的空间重新继承，创建恢复不重放，新会话空目录与重启恢复一致 | 测试 | spec/store.test.mjs |
| INV-17 | 当前任务的 store 引用独立于执行结果租约，跨轮与重启保留，新任务重建；每帧核验权限，超预算明确省略并可分页恢复，CAS 合并不丢引用 | 测试 | spec/store.test.mjs |
| INV-18 | 独立消息只自动投递元数据，处理确认跨重启保存；主题授权与 observe 隔离生效，共享材料按键读取，宿主等待不自动调用模型 | 测试 | spec/store.test.mjs |
| INV-19 | 主会话目标 get/update 的合同由 TS 接口生成，声明、效果和模板一致，模型合同不提供删除 | 测试 | spec/acceptance.test.mjs |
| INV-20 | 声明里写给模型的上限与常量表一致，入参核对引用同一份常量 | 测试 | spec/acceptance.test.mjs |
| INV-21 | 参数化程序的 publish/list/describe 合同、效果与模板同源；发布只检查和归档，执行复用正式 sourceRef 链 | 测试 | spec/acceptance.test.mjs |
| INV-22 | 真实值导出与正文版本按授权发现；指定操作默认不重复整模块模板，多导出共享依赖闭包与模块共同规则，查询不执行业务 | 测试 | spec/runtime.test.mjs |

| INV-23 | npm 环境由宿主绑定持久作用域；查询、变更、回滚合同由 TS 生成；真实 npm 安装、锁文件、版本 CAS、原子发布和进程租约保证后续执行使用新版本、旧执行保持快照；失败与取消保留当前环境，回收不完整保留候选；支持 ESM/CJS、子路径、间接依赖、alias、CLI、重启与历史回收 | 测试 | spec/environment.test.mjs |

## 已受理执行的完成等待

`executions.wait` 与 read/stop 共用当前任务及真实调用身份。waitMs 仅接受整数 1..60000，默认 60000；完成、未知及到期返回同一执行快照，取消只结束等待；不能等待自身。模型声明、发现与模板由操作接口生成，实际核对引用 ExecutionWaitLimits。
