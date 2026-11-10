# 历史读取、取消与输入事实的继续清理

本批沿既有 owner 修复四个实质缺陷，不改模型操作签名、效果、模式、数值上限或生成合同。主分支、版本及发行保持不动；旧 R1/E1/R2/A1/S1/C1 的已绿证明保留，未重复整套验证。

## R3：运行归档读取归 Runtime 存储 owner

`RuntimeSession.inspect/events` 原来直接访问借用存储的 ActRunService，已受理读取可能与 Runtime 的 storage.close 交叉。两入口现在复用同一 readHistory：原根身份与授权逐次核对，Runtime 关闭拒绝新读取并排空已受理读取。关闭的 Session 在 Runtime 存活时仍可读，不打开执行环境；独立 ActRunService 仍由宿主保证借用存储寿命。

Runtime README 与既有有界关闭不变量补全 inspect/events 的归属，未收紧 closed Session 合同。两条真实 SQLite barrier 用例从已关闭 Session 读取，storage.load 同步重入 Runtime.close，验证超时不先关存储、新准入拒绝、放行后原值返回且未调用模型或重开会话。

## A2：取消端口失败仍排空真实子运行

AgentSupervisor 原 cancel 在同步取消端口抛错后跳过 live.promise；parent/global 批次还会丢掉取消拒绝。现在 private stop 直接操作真实 owner，取消错与最终收尾错记入同一失败账，按原对象身份去重，真实 Promise 收束后才结束批次。读取失败账时单错仍原样，多错才组合，不把本类生成的组合错再存回账。

cancelParent 在取活动快照前等待调用当时已受理的 admission gate，避免持久化中的 start 越过父取消；没有永久关闭父身份，后续显式 start 仍合法。README 与 INV-32 明确原父取消/部分结果承诺的实际完成条件，未增加公开端口或改变配额。

四条新增回归覆盖 cancel/parent/global 在取消端口抛错时真实排空、同时投递或子 close 失败的两个原错、不重复记录尾错，以及在途 admission 与后续显式 start；另保留父取消部分结果与落盘错误两个邻近用例。

## F1：授权与写入使用同一输入事实

Features install/remove 原来在等待校验或授权后再次读取调用者的原始对象。install 现在在首个 await 前固定 path 和可选 allowDependencyScripts，remove 固定 id；授权和实际写入使用同一冻结请求。静态校验仍只接 path，省略依赖脚本选项仍保持省略。

两个授权 barrier 回归在确认期间改动原对象，实际安装/卸载仍指向已校验和获准的身份。INV-1 的先确认再写入语义、none→unknown→committed 效果及宿主返回值保持；公开声明、模板和上限没有差量。

## T1：GB18030 保留字节先核对真实前像

旧保留算法只核对字节宽度与 UTF-16 长度，等宽的其他 before 可能通过，正文未改还会提前返回。现在按明确的 GB18030 严格解码 original 并与 before 比较（包括 no-op）；错误沿用 TEXT_FILE_LOSSY，不猜测编码。其余编码的既有快路保持，GB18030 别名字节仍沿原算法保留。

类上方公开 API 原本已承诺 GB18030 前像不符抛 lossy，本批只把正文未改时的先后顺序写清；INV-2 无损承诺不变。四条新增反例覆盖等宽 ASCII、同宽中文、no-op 错前像和非法原字节；两条邻近用例覆盖不支持字符和合法别名字节。

## 验证与边界

统一验证脚本：`.velaros-workspace/semantic-boundaries-20261110/validate.ps1`，仅经跨仓 heavy-validation 原锁助手运行，已 exit 0 并释放锁。改动 lint、`bun run format`、Core→Agent→Velaros 各一次 build/typecheck（顺序 2048MiB）及 `bun run check:module-ownership` 全部通过。定向测试 18 例：R3 两例、A2 六例、F1 四例、T1 六例；无失败或重跑。

各模块精确独立提交；完整生产审查的有限边界及保留理由见 `semantic-review-coverage-20261110.md`。Windows 打开规格与后续新组候选没有混入本批。没有打包、调用真实 provider、跨 OS 矩阵、main 合并或发版。
