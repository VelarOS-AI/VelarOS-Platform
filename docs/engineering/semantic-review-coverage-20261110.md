# 继续轮次的生产模块覆盖

本表只记 0.9.5 后这轮语义审查，不用旧“26 模块基础通读”填平本轮。模块以 `governed-modules.mjs` 为准；整读指手写生产源与合同/README/invariants对照，生成面/模板只作合同参考，测试/vendor不计生产覆盖。已完成 R1/E1/R2/A1/S1/C1 的具体链路不循环重审。

| 治理模块 | 本轮状态/边界 | 结果或有限后续组 |
| --- | --- | --- |
| act/runtime | 重点链路已审；装配/历史owner/Control/子任务收尾及events/inspect已修 | 其余手写生产文件列入 G7；旧具体修复保留 |
| agent | Supervisor、ActRunService相关链路已审；取消/结果失败归集已修 | ActLoop/ContextPlanner其余职责 G7 |
| context | 存储owner/恢复租约相关链路已审 | 未覆盖的存储、证据物化、账本等生产职责 G7 |
| execution | 命令受理、PTY、真实close与dispose相关链路已审 | 其余环境/进程采样等手写职责 G7 |
| features | **整读9份手写TS**及合同/模板 | 管理请求跨await原input可变已独立根修，授权与写目标固定 |
| sessions | **整读10份手写TS**及合同/模板 | 本轮无新缺陷；保留宿主单一排队权威与调用者等待取消，既有workspace能力不搬进Runtime |
| memory | **整读13份手写TS**及合同/模板 | 本轮无新缺陷；保留入口快照、条目锁内revision/标签核验、原子发布与真实提交事实，不吞磁盘错 |
| core/platform | **整读10份手写TS**及合同 | Windows打开规格经CMD二次解析候选，先独立核对设计；路径安全比较仍按实例平台绝对路径 |
| core/text-files | **整读13份手写TS**及合同 | GB18030等宽前像核对已独立根修；保留提交后真实结果与文件句柄收尾 |
| core/path-rules | **整读15份手写TS**及合同 | 本轮无新缺陷；Git非null结论为权威、null才本地规则，派生匹配器缓存不成为规则权威，产品glob与Git语义不混并 |
| images | **整读14份手写TS**及合同 | 本轮无新缺陷；保留locate权限/realpath权威、整批先校验、原字节重试与独占临时资源收尾，取消在图片间生效 |
| web | **整读17份手写TS**及合同 | 本轮无新缺陷；每次尝试独占page，晚到页面仍关闭，取消保留原原因，Google并发gate先占位；页面时间与已保存正文状态分开 |
| script | **整读49份手写TS（含1声明引用）**，另1生成surface | 本轮无新缺陷；保留原生Node与显式合同检查差异、单次调用身份/账/停表、真实进程收束后释放租约，原值与展示预算分开 |
| agent-lab | **整读46份手写TS（含1声明引用）+1 CLI**及合同 | 原子注册候选独立根修中；不可变归档同runId覆盖先登记合同判断。保留原生态驱动与归档/测量分工、完整唯一leg覆盖与缺项/丢失事实、真实任务HTML隐私闭集 |
| act/bridge | **整读9份手写TS**及合同 | finally撤销失败覆盖主错，独立根修中；保留严格信封、双身份租约、先登记后发送与完整结束/JSON校验 |
| act/agents | **整读16份手写TS**及生成面/3模板 | 本轮无新缺陷；parent来自真实调用身份，waitAny先全核归属，runSignal与call signal各管运行/等待，子运行own数据不扩大 |
| act/search | **整读13份手写TS**及生成面/2模板 | 本轮无新缺陷；候选与已读证据分开，每轮核权/发布前复核、CAS激活身份与逐项清理聚合均保留 |
| kernel | G4只读整读中，清单115份TS | runtime、serve/client、updater、remote逐切片，不把清单当覆盖 |
| model | G4只读整读中，清单85份TS | 已读40，剩脚本注册/adapter/requests/wire；无新候选 |
| act/system | G4只读整读中 | 已读装配/目录/操作入口与环境发布，余Store/整理主体及类型工具不假记完成 |
| skills | 本轮未整读 | G5 |
| project | 本轮未整读 | G5 |
| sandbox | 本轮未整读 | G5 |
| browser | 本轮未整读 | G6 |
| computer | 本轮未整读 | G6 |
| office | 本轮未整读 | G6 |

G1为features/sessions/memory，G2为Core三底层单元/images/web。随后按G3→G6补整读，G7只补前四模块未覆盖职责；每组有明确终点，发现实质缺陷再按所属模块独立修复/提交，无问题记录具体保留理由，不以改动数量为目标。Core包其余基础原语不在上述治理26单元中；本轮尚未整体通读，另行列边界，不假记整读。

当前整读13个治理模块、234份手写生产TS（含2份ambient引用）及1个CLI；4个模块只声明具体链路覆盖，9个尚未整读。Windows打开规格保持独立设计项：现有browser-safe CommandSpec承诺可直接spawn并接受任意路径/URL及应用参数，不能以简单替换宿主程序或拒绝合法字符悄悄缩窄合同。
