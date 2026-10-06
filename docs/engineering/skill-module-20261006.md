# Skill 模块与会话加载差量

目标：标准 Node 负责通用编程，velaros:skills 集中提供开发规范、包校验、安装库管理和已选 Skill 加载；Desktop 聊天框「+」控制每次发送的 Skill。

合同变更：SkillsOperationsApi 经 TS 生成六个操作，新增静态校验和发布订阅；SkillRecord 只记录安装事实，SkillSelection 锁定代次与能力授权，SkillActivation 属于租约。acquire 默认空选择。旧 v1 索引在读取边界迁移，安装文件保持有效。不同安装包的公开依赖在同次选择时核对冲突。

模型面：规范和完整示例按 guide 查询，正文按 load 读取，基础提示无需增加 npm 教程。模型写操作交由宿主确认；静态校验不写来源、不执行 provider、不安装依赖；沙箱限制来源真实路径。

Desktop：设置页维护导入、查看、删除；输入框复用 UI 已有的 Skill 菜单和标签，选择归属会话草稿，发送和队列传递版本及授权快照。注册处统一广播管理变更。安装和选择分离需要同步更新前一版 INV-3 与 INV-5，验证会话隔离与按选择组装。

验证：Platform Skill 验收 16 项、73 个断言通过，覆盖真实 Node/npm 与 Kernel、会话授权隔离、升级失效、静态校验、宿主拒绝、发布通知和 v1 迁移。Platform 构建、lint、格式和全部 check:gates 通过。安全 tarball 检查通过并核对内置文档资源；检查项从当前 CodeSurfaces 登记读取。

Desktop 完整 check 通过（含四个顺序类型分区和 47 项会话回归），聊天提交 15 项、队列与选择 8 项、IPC 20 项、真实受限 npm 安装 1 项通过。主进程、preload、renderer 构建与入口验证通过。本轮验证使用进程与组件合同；可视界面未进行运行验收。

本机开发数据的 Skill 库已导入 guided-review，默认选择集为空。完整示例也由 guide({topic:'example'}) 随产品提供。
