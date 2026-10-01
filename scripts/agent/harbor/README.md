# ScriptAct / Harbor 实测入口

把正式 `createRuntime`、Project 与 Shell 接到 [Harbor](https://docs.harborframework.com/core-concepts/agents/custom-agents) 的任务容器。模型、并发、资源和预算由冻结清单约束，当前配置见 [ScriptAct 状态](CURRENT.md)。输出完整原始 trace、ATIF 1.8 轨迹、官方 verifier 结果和请求费用账。

当前工作以 [ScriptAct 状态](CURRENT.md) 与 [历史执行回顾](RETROSPECTIVE.md) 为准：分析已有记录、修复遗漏并完成本地回归。下文保留评测入口的安装与协议说明。

## 环境与版本

本次环境为 macOS ARM64、Colima 0.10.3 / VZ / Rosetta、Docker 29.5.2、Harbor 0.23.0、Node 24.15.0、Bun 1.3.13。独立 profile 为 `scriptact-bench`，2 CPU、24 GiB 数据盘，只挂载仓库的 `.velaros-workspace/bench` 目录。Terminal-Bench 批次 VM 使用 4 GiB 内存；进入每题要求 4 GiB 的 SWE-bench Pro 后，VM 调为 6 GiB，为 Docker 与网络 helper 留出空间，所有仓库参与者共享该配置。安装没有启用开机服务。

```sh
brew install colima docker docker-compose docker-buildx
mkdir -p .velaros-workspace/bench/docker-config
python3.12 -m venv .velaros-workspace/bench/venv
.velaros-workspace/bench/venv/bin/pip install 'harbor==0.23.0'
colima start scriptact-bench --cpus 2 --memory 4 --disk 24 --root-disk 8 --vm-type vz --vz-rosetta --activate=false --ssh-config=false --mount "$PWD/.velaros-workspace/bench:w"
```

将 Homebrew 的 Docker CLI 插件目录加入上述独立 `docker-config/config.json`：

```json
{"cliPluginsExtraDirs":["/opt/homebrew/lib/docker/cli-plugins"]}
```

官方 PyPI 在本次网络中超时，实际通过清华 PyPI 镜像安装相同固定版本。Docker Hub 不可达，hello-world 使用 AWS Public ECR 的 Docker Official Image `public.ecr.aws/docker/library/ubuntu:24.04` 拉取后标记为 `ubuntu:24.04`，以 `DOCKER_BUILDKIT=0` 构建；任务文件没有改动。Terminal-Bench 使用任务元数据指定的 GHCR 预制镜像。

## 构建和运行

所有命令从 Platform 仓库根目录运行。准备脚本复用仓库的安全打包入口，只打包正式发布内容；依赖锁、源码提交与 bundle 指纹随结果保存。`prepare-linux.py` 用 Bun 的 Linux 目标选项在宿主安装锁定依赖，核对官方 Node SHA-256，并生成完整 Linux 归档；安装阶段只上传、解压和验证正式入口。ARM64 任务使用 `--arch arm64` 单独准备。

每个候选使用新的 bundle 目录；`prepare.mjs` 拒绝覆盖非空目录。已存在的 Linux/Codex 归档只在指纹和哈希匹配时复用，防止后续准备改写旧试验的安装依据。

`prepare.mjs --resident-exports shell.run,project.edit` 将指定操作的正式声明及依赖类型放入首轮说明，配置参与候选指纹；完整模块仍可用 `--resident-modules` 指定。主指标是实际任务请求数、耗时与费用；预置说明的字符量与本地合成响应只验证交付行为，不能证明模型会省去查询轮次。

迭代候选必须沿用上一轮依赖锁，例如 `node scripts/agent/harbor/prepare.mjs .velaros-workspace/bench/candidate-v2 --model gpt-5.6-sol --reasoning high --pricing .velaros-workspace/bench/parallel-54/model-pricing.json --lockfile .velaros-workspace/bench/candidate-v1/bun.lock`。准备脚本用 frozen-lockfile 校验，并在 identity 中记录锁文件 SHA-256。

`--model` 和 `--reasoning` 必须明确给出。`--pricing <JSON>` 将该模型、推理参数对应的单价与原文件 SHA-256 冻结进候选身份；价格文件使用 `schema:1`，包含 `model`、`reasoning_effort`、`service_tier`、`input`、`cachedInput`、`cacheWriteInput`、`output`、`longThreshold`、`longInputMultiplier`、`longOutputMultiplier`、`unit:"USD per million tokens"`、`source`、`verified_at`。缺少单价或用量分项时，适配器费用保持未知。评测总费用以归属明确的网关请求账本及其每次请求冻结的价格为准，报告保留适配器原始金额和对账差异。

兼容接口的能力应独立声明。`--openai-explicit-cache-breakpoints disabled` 将 `openaiExplicitCacheBreakpoints:false` 冻结进候选及模型连接，阻止内部历史标记翻译成该接口不支持的显式断点；`enabled` 明确启用，省略沿用模型适配器默认能力。原始历史内容和展示策略保持一致。

自定义上游通过网关的 `--upstream-url` 明确授权，必须与私有凭据配置的 API 根一致；清单 `gateway.upstream` 冻结规范化 `baseURL` 及其 SHA-256 `endpointId`。价格文件可声明 `pricingBasis:{kind:"reference_only",source:"价格来源",upstreamBaseURL:"API根"}`，报告将其标为参考估算，实际扣费保持未知。上游 401 会阻断后续请求；更新凭据后验证权限，再使用新的网关实例、账本和批次。

结果租约实验可通过 `prepare.mjs --result-retain task` 使用已有 Runtime 配置，将默认结果保留到逻辑任务结束；也可指定 1 至 32 次曝光。配置写入 identity 并参与 bundle 指纹，旧 bundle 保持原配置。该实验须同时比较缓存写入、上下文峰值、整理调用及任务成绩，不能仅以缓存率评判。

上下文工作窗口实验使用 `prepare.mjs --working-window <token 数>`，允许 1 至 922,000，配置写入 identity 的 `context.policy.windowTokens` 并参与 bundle 指纹。默认工作窗口为 200,000；模型本身的上下文容量、输出预留和安全预留仍约束实际输入上限。窗口大小应作为独立变量在长程任务上比较完成率、整理开销、费用和缓存，不能将增大窗口直接视为改进。

```sh
node scripts/build/buildPackageTopology.mjs --for @velaros-ai/velaros --incremental
node scripts/agent/harbor/prepare.mjs .velaros-workspace/bench/candidate-v1 --model gpt-5.6-sol --reasoning high --pricing .velaros-workspace/bench/parallel-54/model-pricing.json
node --test --test-timeout=15000 scripts/agent/harbor/harbor.test.mjs
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-linux.py --bundle .velaros-workspace/bench/candidate-v1 --arch x64
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-environment.py
```

启动器在付费样本批次前自动检查并预取整组镜像，保存 image ID、仓库 digest 与大小；任一镜像失败时停在模型派发之前。也可单独预检：

```sh
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-images.py \
  --tasks-root .velaros-workspace/bench/datasets/terminal-bench-sample --all \
  --output .velaros-workspace/bench/campaign/sample-images-preflight.json
```

镜像预检清单使用新文件名，保留每次失败证据。`--task` 可重复指定小批任务；大型数据集先固定任务列表再预取。

仓库题的 GHCR 元数据统一使用 `repository_resolve.py`，通过可重复的 `--image` 传入原始镜像名，`--cache` 指定元数据缓存，`--output` 指定新的证据文件。它同时声明 OCI 索引、Docker 清单列表和单镜像类型，选择唯一的 Linux AMD64 描述文件，核对配置平台、描述符大小与 SHA-256，并保留根索引摘要。用于正式导入的 `identity.id` 是选中平台的描述文件摘要。解析阶段只读取元数据，镜像完整性仍由后续压缩层 SHA、解压 diff-ID 与导入核验确认。

GHCR 在缺少 OCI 索引 Accept 类型时也可能返回 `404 / MANIFEST_UNKNOWN`。任务镜像可用性必须经过上述完整类型协商；旧的只接受单镜像的探针结果不能单独证明镜像缺失。

`--name` 为批次前缀，启动器追加 agent 名称；单 agent 可用 `--job-name` 指定冻结清单里的精确 job 名称。

在一个终端保持费用网关运行。真实 API key 仅从指定 Desktop 配置加载到宿主内存；日志不保存 key，容器仅得到随机 campaign token。

```sh
node scripts/agent/harbor/budget-proxy.mjs \
  --directory .velaros-workspace/bench/campaign \
  --desktop-config /Users/mac/Desktop/VelarOS/projects/VelarOS-Desktop/.velaros/data/config/settings.json \
  --budget 1000
```

另一个终端运行第一轮真实任务及对照组：

```sh
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/launch.py \
  --agent pair --name pilot-01 \
  --task regex-log --task build-cython-ext --task fix-code-vulnerability
```

省略 `--task` 跑完整十题样本；`--attempts 5` 每题独立运行五次。默认数据集为 `terminal-bench-sample@2.0`。`--agent codex` 运行官方 Codex CLI 0.158.0，`--agent all` 顺序运行 ScriptAct、Terminus‑2 和 Codex。各组使用同一个 GPT‑6 Sol high 和官方默认任务时限，trial 并发固定为 1。ScriptAct 模型请求并发也限制为 1。Harbor 基础设施自动重试关闭，所有失败留在原始结果里。

Terminus‑2 使用原生 Chat Completions 模式，每轮发送完整对话。Harbor 0.23.0 的 Responses 模式通过 previous_response_id 续接，需要服务端存储，而本 campaign 网关固定 store=false。两轮本地接口预检确认 Chat Completions 出线为 gpt-6-sol / high，并保留先前对话；预检没有调用付费模型。实际费用以共享网关的完整 usage 核算。

本机 Codex 在线安装触及 360 秒 setup 上限。先运行下面的准备命令，`launch.py` 会自动使用校验过的离线归档；官方 Codex CLI、Harbor 的任务提示、执行命令和轨迹转换逻辑保持原样。归档包含固定版本 CLI 与 Node 24.15.0，依赖锁和整体 SHA-256 随结果保存。`--codex-bundle` 可显式选择归档。运行时认证只通过共享费用网关。

仓库对照的费用网关提供 Responses HTTP。Codex 0.158.0 通过清单里的 `config.model_provider` 选择独立 provider，并在 `model_providers.<id>` 指定 `wire_api="responses"`、`supports_websockets=false`、网关 `base_url` 与 `requires_openai_auth=true`。具体字段见 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。固定 CLI 的断网探针已验证单次 POST 和原生正常完成，证据 `campaign/validation-32-transport-validation.json`；该版本禁止覆盖内置 `openai` provider。每次传输配置变化须保留新清单和新的运行记录。

```sh
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-codex.py
```

```sh
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/report.py \
  .velaros-workspace/bench/jobs/pilot-01-scriptact \
  .velaros-workspace/bench/jobs/pilot-01-terminus-2 \
  --output .velaros-workspace/bench/pilot-01-report.json
```

运行结束后可停止专用虚拟机释放内存：`colima stop scriptact-bench`。重跑前启动该 profile，并保持原费用账。

## 费用边界与可审计性

[GPT‑6 Sol 官方价格](https://developers.openai.com/api/docs/pricing)为输入 $2/M、缓存读取 $0.20/M、缓存写入 $2.50/M、输出 $10/M；超长上下文采用更高费率。网关每次请求先持久预留 $20，完整 usage 到达后以长上下文保守费率结算预算；缓存字段缺失时按输入全部写缓存计算上界，费用估算保持未知。未知 usage 保留预留额；重启不释放，第二个网关进程不能占有同一本账。费用账的保守占用值与已知实际用量估算分别展示，最终账单以供应商为准。

只接受本批显式冻结的模型、推理力度与标准服务档位，开放 Responses / Chat Completions 两个入口；付费托管工具不在此入口开放。网关到供应商使用 HTTPS，容器访问宿主的随机 token 认证入口。费用上限覆盖模型调用；本机环境无需购买云计算资源。

任务指令由 Harbor 直接传入，运行中不向模型提供隐藏测试或参考答案。容器内允许无人值守命令；CLI 只有在 Linux Docker 容器标记和显式环境标记同时存在时才运行。运行结果是否正确由官方 verifier 决定，模型自行宣布完成不算通过。

每轮保留：`config.json` / `lock.json`、task checksum、bundle 指纹、模型原始响应与实际调用回执、ATIF 子轨迹、异常及 verifier 输出。中断或缺失用量保持未知。费用修复之前的 trace 缺少缓存计数时，费用以网关账本为准。

工具计数按层级记录：`tool_call_scope=scriptact_host_operations` 是 ScriptAct 去重后的底层能力调用；`atif_model_tool_calls` 是原生轨迹中的外层模型工具调用，一次脚本调用可以包含多个底层操作。Codex 的 `native_operations` 从原生 JSONL 逐条完成事件按线程与条目 ID 去重，分列命令执行、文件修改操作、未结束条目和未知退出码；文件修改按操作数计，缺少原生证据保持未知。报告不把这两个层级的工具数直接当作效率差值；完整模型请求数仍由网关计量。

费用报告按请求中的冻结单价分别汇总普通输入、缓存读取、缓存写入与输出，包含适用的长上下文倍率；输出包含推理 token。缺失 usage 或价格时保持未知，实际零次请求记为零。

并行仓库对照按签名的 campaign、candidate、participant、task、attempt、job 和 phase 身份归账；历史缺少签名的单并发记录另保留时间窗口口径。agent 阶段结束后新发起的请求另列 post_agent 指标，继续计入该题总费用。网关按全局及每次尝试的并发上限派发、记录排队时间；每个真实上游请求结算后才释放自己的槽位，客户端提前断开仍保留迟到用量。

网关本地请求校验返回 400，预算耗尽返回 429，上游连接异常返回 502，超时返回 504；供应商已返回的 HTTP 响应保留原状态。传输错误记录受限的错误标识与持续时间，缺失 usage 继续保留预算预占。原生执行命令的超时 Bash 必须启用 pipefail，防止 `tee` 掩盖失败。历史 Codex 日志的终止事件另行核对：官方分数与原异常保留，`turn.failed` 或没有正常终止事件的已结束任务不能计作无异常成功。

流时序分别记录首末字节、文本/工具/推理摘要活动、`stream.firstTerminalMs`（首个完整协议终端）、`terminalMs`（当前记录的终端事件）和 `transportEndedMs`（EOF 或中断）。这些都是相对上游派发的单调时钟偏移；完整 SSE 分隔符之前不记录终端，重复终端不覆盖首次时刻，失败仍保留失败。客户端提前完成后，网关继续读取迟到用量，并在真实传输结算后释放请求槽。不能用最后一个文本 delta 代替协议终端，也不能把网关寿命、模型等待和工具执行时长直接相加。

每条请求的 `metadata.wireOptions` 保存网关规范化后的推理上下文、摘要、输出详细度、工具并行及存储选项；省略、null、白名单值和其他值分开表示。`include` 仅记录项数和加密推理开关；终端响应的有效推理上下文另记在 `stream.effectiveReasoningContext`。不记录任意选项字符串、提示正文或凭据；未知值不会被推定为默认值。原始请求参数不因这些观测而改变，历史账本也不补造缺失信息。

仓库清单的 `execution_env` 对源 Agent、重放 Agent 和 verifier 统一生效；与参与方环境冲突时拒绝启动，效率对照也要求该配置相同。本机 Rosetta 的 Go ChaCha20 AVX2 路径已由独立 TLS 探针复现错误，采用 `GODEBUG=cpu.avx2=off` 后官方参考解法和原有补丁验证均通过，见 `campaign/validation-33-rosetta-go-tls-validation.json`。每道新题付费前先用相同镜像、资源及执行环境运行官方参考解法做零模型预检；参考解法仅在隔离验证中执行，不提供给参赛模型。环境修复后的重放使用新 job，保留原分数；源环境不同的效率数据只作补充诊断。

已发起请求的供应商结算可能晚于容器清理；`provider_settlement_seconds_after_cleanup` 单列这段等待，仍在结算或缺少完成时间时保持未知。其费用按请求起点归属原 trial，不因下一阶段开始而丢失。`response_rejections` 按错误码保留全部拒绝，取消与未知错误不计入协议格式拒绝；官方超时、reward 与费用不随诊断分类改变。

容器取消协议通过 `launch.py --cancellable-exec` 显式启用，环境类和源码摘要随日志保存。每条命令置于独立进程组，Harbor 取消后先 TERM、两秒后对残余进程 KILL，再进入判分；正常完成命令启动的独立服务不被取消其他命令时清理。无模型的 `cancellation-probe.py` 和独立安装预检已通过；从 sol-validation-08 起按 `execution-protocol-amendment-01.json` 启用。比较不同执行协议的批次时须保留这一差异。

该候选在环境准备阶段等上一题的供应商请求结算结束，再开始下一题 agent 计时；网关需提供 activeUpstreamRequests。环境等待、agent 运行和判分时长分别保存。新准备的 ScriptAct bundle 同时通过宿主环境报告提供真实 shell 路径、类型和版本，刷新环境后同步更新。

`report.py --task <任务名>` 可重复指定预先冻结的开发组或验证组；报告按同一组重新计算计划数、待完成数和共同成功效率，全量报告及原始记录继续保留。

`report.py --cohort <清单.json>` 按事先固定的 participant/job/task 来源生成补充对照。每个参与者的每道题只能指定一个来源，数据集版本和模型须一致；来源尚未启动时计入待完成数，后续失败也照常计分。基础设施恢复前的记录继续保留在全量报告中。任务来源须在恢复试验出分前冻结，不能按成绩挑选尝试。

## 比较口径

样本集来自官方注册表，Git commit 固定为 `7e917f35c281188532772312d4ad91ca9274febc`。首轮三题是接入试跑，不代表完整榜单。结果按全部尝试计算，与 Harbor 一致保留官方 verifier reward，无判分的尝试计零；运行异常和基础设施错误分别列出，未完成的 trial 保持待定。共同成功效率限定判分通过且无运行异常的尝试，同时报告全部判分通过数、无异常通过数和全部费用。优化后的运行使用新 job 名称并保留原结果，不能挑选重试成功覆盖失败。

本机 AMD64 任务经 Rosetta 运行，其耗时不能直接等同原生 Linux 榜单机器。正式结论需要完整数据集、重复试验、统一资源和统计不确定性。当前 [Terminal-Bench 4.0](https://www.tbench.ai/run)包含 GPU 任务；[官方提交规则](https://github.com/harbor-framework/terminal-bench/blob/main/leaderboard/SUBMIT.md)要求固定版本、默认资源与时限、至少五次试验和完整轨迹，并且当前社区提交尚未开放。本目录先建立可复现的本地比赛和排障链路。

评测故障须保留证据并分清来源。出现宿主兼容错误时先用无模型探针复现；说明与判分假设存在差异时登记限制，官方 reward 仍保持原值，隐藏测试细节不进入 agent 提示或实现。新验证组在执行前冻结，避免根据已知结果挑题。

## 持续迭代与指标

所有新试验固定 GPT-6 Sol high、Standard、trial 并发 1，共用原有 $1,000 账本。代理保存每次调用的模型、推理档位、单价快照、原始 usage、首包/首段正文/首段推理延迟与请求总耗时。报告同时生成 JSON 和 Markdown。缓存命中率按 token 总量加权；字段缺失保持未知，不记为零。请求时长包含网络和服务端等待，不等于纯生成时间。

在正确完成相同任务并保留必要验证的前提下，以完整模型请求数和任务总耗时为共同主指标，同时降低完整尝试费用。拒绝、修复、上下文维护和失败尝试全部计入；请求数下降但耗时或费用上升时逐项报告得失。缓存、token 和上下文指标用于解释差距。每轮同时保留全部尝试通过率与异常、agent/安装/判分/总耗时、P50/P90、含失败尝试的每成功任务费用摊销、输入/输出/推理 token、缓存读取/写入/命中率、输入峰值、工具失败、协议修复、上下文准备时间、维护模型调用和观察到的封段次数。不同 agent 未暴露的内部数据保持未知。效率结论应在双方成功的同题集合复核，失败样本仍计入总体成绩、请求数与总成本。

Shell 计数分别报告完整可测回执数、命令失败次数、有 stderr 的命令数及退出成功但带 stderr 的命令数。stderr 是观察日志，不能据此判任务失败；截断或缺失输出不伪造为无错误。自动诊断是否进入模型材料另用逐调用身份和真实请求核对。

`report.py` 以第一个 job 为参照，自动生成共同成功任务的请求数、时间与费用比值；每题先计算成功尝试均值，再按题等权。未完成批次明确标记，未知值不填零。这是成功条件下的描述性结果，需要结合全部尝试的成功率、请求数和成本解读。

任务阶梯：三题接入 → 十题公开样本 → Terminal-Bench 正式任务分层抽样 → SWE-bench Pro 多文件长程修复；每一级预先冻结任务、数据版本、预算和资源配置。通过率接近时检查效率差异；区分度不足就扩大样本/重复次数或进入更难一级。候选修复先在开发集定位，以不同 job/bundle 保存前后结果，再验证独立任务；禁止把某次重试成功覆盖原失败，也不把隐藏测试内容交给参赛模型。每轮只采用有证据改善质量/时间/费用且没有不可接受退化的修改。

难度升级以整组结果为依据：双方接近满分且效率没有稳定差异时，进入更长、跨文件依赖更多或验证更复杂的任务；双方大量失败时，先定位共同环境故障与失败阶段，再补充能产生部分成功的任务层级。不能持续加难直至双方都为零，再把零分解释为相当。每一级继续保留成功率、全尝试成本和共同成功效率，不将时间、费用与正确性随意压成单一总分。

候选筛选使用开发集，确认排名使用事前冻结的独立题组。重复运行须使用相同次数，并在付费派发前固定双方顺序和资源；预先确定整组完成后分析，避免出现有利结果就提前停止。差距不稳定时增加重复次数或样本，按题汇总差异和不确定性；任务类型之间有取舍时报告各自优势，不强行宣布唯一赢家。若预算或机器资源限制后续区分能力，应如实报告证据不足。

Codex 的 GPT-6 Sol 对照可直接使用官方 Responses。Claude Code 的原生模型接口与 GPT 接口不同：若接入协议转换层，报告必须标为转换后的配置，不能声称是 Claude Code 原生默认成绩。公开排行榜只有模型、任务版本、资源、时限和试验规则可比时才作为直接对照。

`anthropic-bridge-probe.py` 使用本地 HTTP 假服务核对 LiteLLM 1.103.0 的 Anthropic → Responses 转换，`--stream` 检查 SSE 事件与工具参数组装。两轮覆盖完整历史、工具 ID、GPT-6 Sol high、store=false 和缓存读写计数，不调用真实模型。Claude Code CLI、取消传播和完整任务运行另行预检，该脚本通过不代表已有 Claude Code 成绩。

当前上下文上限分别记录模型能力与 agent 实际策略；Codex 显式配置模型窗口 1,050,000 / 自动整理阈值 900,000，ScriptAct 输入能力 922,000，实际分段策略从 trace 采集。Terminus-2 使用 Chat Completions 并显式登记该模型窗口。依赖镜像对所有 agent 和 verifier 一致设置，任务文件与测试保持原样。首轮清华镜像遇到 TLS 提前断连；后续批次统一切到阿里镜像、UV 原生 TLS、30 秒连接超时与 5 次网络重试，官方任务时限不变。独立容器使用相同 UV 0.7.13 完成了无缓存 pytest 安装验证。

缓存净节省按同一输入全部使用普通费率的费用减去实际缓存读取/写入费用计算，可为负值；不能只提高命中率却忽略写入开销。

`context.prompt_layout` 从记录的 provider 请求区分完整提示文本和每轮工作帧的字符数，并单列非文本块数量、原始 frame 各分区紧凑 JSON 的大小；缺失请求不补零。字符量只用于定位重复传输和增长的位置，不能替代供应商 token、缓存或费用。Markdown 展示工作帧峰值，完整分布保留在 JSON。

本机后续 trial 使用统一的 `BenchmarkDocker` 环境：Debian/Ubuntu 官方包通过阿里镜像取得，保留发行版签名和 TLS 校验，设置有界下载重试；精简镜像使用 certifi 的公开 CA 集完成首次 HTTPS 安装。十题官方 verifier 都使用 [UV 0.7.13](https://github.com/astral-sh/uv/releases/tag/0.7.13)，环境预置该版本官方归档并校验发布的 SHA-256，避免在线安装脚本中断后判分工具不存在。环境启动日志记录配置脚本、CA 集和 UV 归档哈希。它对所有 agent 及 verifier 一致生效，任务源码、判分脚本和时限保持官方版本。比较环境修订前后的结果时须保留该差异，新一轮直接对照统一使用同一环境。

`launch.py --agent codex --task regex-log --name environment-preflight --install-only` 验证环境和 agent 安装，不调用模型。此类安装预检 job 单独保存，不纳入解题成绩。


## 长程仓库阶段准备

`repository_agents.py` 为 ScriptAct、固定版本 Codex、Claude Code 协议桥和 Terminus-2 保留原生执行循环，在 50 分钟阶段内预留最后一分钟采集补丁。宿主循环具有独立截止时间，安装式 CLI 同时在容器内使用 timeout；取消由共享环境传至命令进程组。运行前记录 Git HEAD，并用临时 index 将实际初始工作区写成基准树，包含镜像原有的未跟踪文件和跟踪文件状态；HEAD、原 index 与工作文件保持不变。结束时另一份临时 index 采集相对该树的完整二进制 diff，包含 agent 自行提交、新增、修改和删除的文件。`patch-capture.json` 保存 `base_commit`、`base_tree`、采集状态和字节数。初始快照失败会在调用模型前停止。该入口仅用于 Docker 仓库任务，普通 Terminal-Bench 批次继续使用原入口。

本地回归通过临时仓库把这些变更应用到新克隆并逐字核对：

```sh
PYTHONPATH=. .velaros-workspace/bench/venv/bin/python scripts/agent/harbor/repository_test.py
```

本地补丁校验不是正式 SWE-bench 成绩。正式派发前仍须验证分阶段联网限制与官方 PatchReplayAgent 的全新容器重放；重放失败、缺失补丁或采集失败必须单列，原 agent sandbox 中的判分不作为最终成绩。

NodeBB 官方镜像原有三个未跟踪的 Redis 数据文件。初始状态回归验证既有文件和 index 保持、无改动时补丁为空、跟踪与未跟踪文件的增删及二进制修改可在相同初始状态中重放。真实 NodeBB 镜像的零模型双容器验证见 `probes/nodebb-baseline-35-2/result.json`；该夹具检查补丁传输，不计为任务得分。

`repository_probe.py` 准备了零模型 Docker 联测：源容器在真实截止时间取消后采集补丁，三个新容器分别用固定官方 PatchReplayAgent 检查有效、空和损坏补丁。合成 verifier 核对提交过的改动、新增文件、删除和二进制内容，并确认仓库外文件没有随补丁进入新容器。源阶段关闭 verifier。它只使用人工夹具，结果不计入 SWE-bench 成绩；运行入口是 `PYTHONPATH=. .velaros-workspace/bench/venv/bin/python scripts/agent/harbor/repository_probe.py`，要求专用 VM 与费用网关均空闲。

`repository_launch.py --manifest <冻结清单> --attempt <从 1 起的序号>` 执行清单内的一次源任务，再用官方 PatchReplayAgent 启动全新容器判分。源任务关闭 verifier，固定源/重放 job 名称，已有结果拒绝覆盖。每次派发核对任务暴露归属、任务文件、执行代码、参与者归档、镜像身份、VM CPU/内存和费用余额。任务必须完整检出，冻结文件集合须与数据集原提交的该任务文件集合一致，题目、配置、镜像构建文件和验证入口必须存在；仅有元数据的稀疏检出在调用 Harbor 前明确报错。`--install-only` 只检查正式任务容器中的安装，并要求费用网关请求数不变；`--dry-run` 校验后打印不含凭据的命令。若源任务已结束而重放尚未派发，`--replay-only` 可单独执行已声明的判分阶段。

新候选冻结前，运行 `python3 scripts/agent/harbor/task_exposure.py --jobs-root .velaros-workspace/bench/jobs --output <新的暴露快照.json>`，从锁定任务和运行元数据采集已观察任务。后续快照用 `--previous <上次快照.json>` 保留手工观察及已归档的作业，人工读过或用于指导修复的任务用可重复的 `--observed-task <完整任务 ID>` 登记。命令只读取元数据，拒绝覆盖旧快照。

新执行清单使用 ISO `frozen_at`，并加入 `evaluation: {schema: 1, roles: {"完整任务 ID": "held_out"}, exposure_snapshot: {file, sha256}}`；`roles` 的值只能是 `held_out` 或 `development`，且必须恰好覆盖本清单安排的任务，`exposure_snapshot` 使用上述命令返回的路径和哈希。暴露快照必须早于候选冻结时间；冻结前已观察的任务只能标为 `development`。派发和报告都会校验快照身份与当前历史元数据，漏记、改时间和重复题冒充留出题均报错。冻结后同一预定组的双方执行不会污染该组的归属。执行文件清单须包含 `task_exposure.py` 与 `runtime_artifacts.py`。

历史清单可以继续生成补充报告；缺少结构化归属的任务标为 `unverified`，独立留出计数为零，成绩、时间、请求数和费用照常保留。原始清单、快照和报告应始终保留。

宿主工具预探测按项目配置选择命令，覆盖根目录与嵌套目录中的 Go、JS 包管理器、Python、Rust、Maven/Gradle 配置。发现最多进入 32 个目录、处理 2048 个条目、深入 3 层；跳过依赖/构建目录和符号链接，不读取或执行配置正文。实际 PATH 命令探测结果连同 `commandDiscovery` 范围一并交付模型。该清单始终是局部发现，未列出的命令保持未知，需要时在执行相关检查的同一脚本中核实项目工具链。刷新 Shell 环境时重新发现；发现代码参与候选包指纹。

当前比较对象为 ScriptAct 与冻结 Codex 0.158.0，均使用 GPT‑6 Sol high，先修复产品缺陷，再运行必要的同题验证。当前冻结清单、实测结果与下一步见 [CURRENT.md](CURRENT.md)。每个新任务在双方派发前封存候选与协议，产品修复另外建立版本记录。修复验证使用事前固定的同题 Codex 原始结果；独立仓库验证沿用原冻结题组，结果按候选版本分别报告。执行协议固定原二十份执行代码、依赖版本、模型档位、CPU/内存、任务时限、官方任务文件与镜像身份。安装预检独立记录且不能调用模型。Docker 29 containerd 存储的 image ID 为 manifest digest，清单同时保存该身份与独立 config digest。

`repository_images.py --manifest <冻结清单> --task <任务 ID> --name <独立证据目录名> --gateway-directory <本批网关目录> --gateway-url <本批本地网关地址>` 从宿主通过正常 TLS 获取清单规定的 GHCR 原始内容，校验压缩 blob、配置及解压层摘要，按 [OCI image layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) 保留原始 manifest 与内容后导入专用 Docker。下载使用 curl 的 90 秒总时限、进程级兜底、四次重试和精确续传；持续零星收包也会按总时限结束并保留已下载前缀。认证经标准输入传给 curl，默认 TLS 校验，凭证及重定向 URL 不进入参数或错误日志；内容通过完整摘要后才发布到缓存。证据保存下载记录、归档摘要和实际导入身份。运行前及导入前用显式指定的同一网关地址和目录核对活跃及排队请求，要求整个专用 VM 无容器，并检查磁盘余量，成功后回收本次派生归档。此流程只准备原始任务镜像，不修改官方环境或任务文件。`repository_images_test.py` 验证字节级身份保持、损坏/解压摘要不符拒绝、真实本地 HTTP 续传及服务器忽略 Range、持续收包总超时和凭证隔离；真实后续镜像导入结果另记。

`repository_report.py --manifest <冻结清单> --output <报告.json>` 合并两阶段证据：正确性取新容器官方 reward，保留源运行异常及费用；解题、源任务、重放、verifier 与含间隔的端到端时间分别记录。重放未结束的源任务保留费用而不提前计入成绩。`repository_report_test.py` 验证超时但补丁通过、失败重放、待判分费用和任务身份不一致等情况。

候选清单可用 `reference_manifest`、`reference_manifest_sha256` 和 `reference_sources` 指定事前冻结的参考来源。报告核对参考文件摘要、执行协议、任务身份和同题集合后，按这些来源合并对照；替换来源、重复尝试和模型/环境漂移会失败。Markdown 首先列出已结束源任务的完整请求数、已知费用及未知费用请求数，随后并列同题请求数、解题时间和费用，以及共同正常成功题的三项比值；JSON 保留全部尝试费用、上下文和缓存细项，并记录报告分析代码的 SHA-256。执行中的源任务尚未进入单 agent 请求和费用列，实时预算占用单列在 campaign。重算报告另存文件，保留原始报告与冻结执行清单。

缓存前缀候选 `bundle-sol-cache-prefix-v1` 在较早的已退役结果后增加断点，并按剩余槽位传递最多三个内部缓存断点，保持结果正文、展示租约及运行配置。其当前三题清单是 `campaign/swebench-pro-v2-cache-prefix-execution-02.json`，与基线 installation 修订对齐并保留原候选归档和来源；参考 12 批 ScriptAct 的固定三次尝试，按 `execution_after` 等待四 agent 十二次官方重放全部结束后执行。该顺序目前由调度操作核对，单次启动器不自动检查此字段。先完成候选的正式容器安装预检，再开始付费任务；收益以提供商 usage、同题成功效率和全尝试成本衡量。

`portable_terminus.py` 只处理原生 Terminus 安装兼容：将多级区域 Ubuntu archive 域名映射到同一包源；Ubuntu 20.04 的 tmux 3.0a 使用登录 Bash profile 接收原先五个包源变量，其他发行版使用原生 `new-session -e`。允许的变量限定为已冻结的包下载配置，Terminus 的模型循环、解析和执行逻辑沿用 Harbor。真实 Ansible 容器预检 `sol-repository-development-12-terminus-1-preflight-03.json` 通过、零模型请求，前两次安装故障独立保留。

本机 Docker Hub 连接失败时，单独准备 `local-harbor-gost-3.2.6-v1` 网络 helper。`prepare-egress.py prepare` 要求已下载的官方 GOST 3.2.6 ARM64 归档与 checksums，核对固定 SHA-256，逐字复制 Harbor 0.23.0 的网络策略脚本，并记录缓存 Ubuntu 基础镜像 ID。`build` 只允许在专用 VM 没有运行容器时执行，保存最终镜像 ID、包版本和构建日志；已有证据拒绝覆盖。此 helper 为 ARM64，实际任务仍运行各自固定的 AMD64 镜像。

```sh
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-egress.py prepare
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/prepare-egress.py build
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/network-probe.py
.velaros-workspace/bench/venv/bin/python scripts/agent/harbor/qemu-preflight.py
```

`RepositoryBenchmarkDocker` 使用冻结 helper 身份和原生 Harbor 策略切换；`network-probe.py` 在真实 Harbor 容器中检查准备阶段可达、agent 白名单、完全禁网和判分阶段恢复可达，连接本地标记服务及费用网关的未认证 health 入口，不调用模型。`qemu-preflight.py` 从原始任务镜像运行有界最小启动，保留退出码及 stderr。两类探针结果独立保存；网络与补丁重放预检完成后，才冻结长程付费批次的最终执行协议。

GOST 3.3.0 的实测在白名单阶段同时拒绝了网关和被禁止的地址，失败证据保留。3.2.6 使用相同 Harbor 网络策略文件，实际四阶段探针通过后成为默认仓库 helper。`--gost-version`、`--directory` 与 `--assets` 可准备独立诊断版本，`network-probe.py --helper-directory <目录>` 指定实际测试的构建；探针保存全部阶段和失败时的代理日志。长程付费任务还需完成干净容器补丁重放预检。

`portable_claude_code.py` 仅替换 Harbor 原生 Claude Code 适配器的安装阶段：核对官方 Linux x64 归档摘要，在容器中安装固定版本，检查实际版本并记录身份。2.1.283 已通过真实 CLI 的两轮合成响应/工具往返，以及 CLI → GPT 协议桥 → 合成 Responses 的联合预检；本地集成检查不等于已有 Claude Code 跑分。

`claude-cli-probe.py` 在专用 VM 空闲时创建独立临时任务，用本地合成 Anthropic 流式响应驱动固定 CLI 执行 Bash，再验证真实文件和工具结果历史。宿主提供商凭据不传入子进程；费用网关请求数必须保持不变。此夹具保存在 `bench/probes`，不进入评测排行榜；模型名直接使用 `gpt-6-sol`，避免 Harbor 自定义 base URL 路径把提供商前缀传给 CLI。

`anthropic_bridge.py` 是限定当前 campaign 的 HTTP 接入：使用 LiteLLM 1.103.0 的内容转换和独立管理的 OpenAI SDK 传输，固定 GPT-6 Sol high、store=false、零 SDK 重试，只有共享费用网关是上游。保留完整工具历史、加密推理内容和原生 ephemeral 文本/图片内容缓存断点的位置；不支持的 TTL 或上下文编辑明确返回错误。工具调用、工具结果和推理块的原生断点没有相同位置的 Responses 显式字段，保留原始内容并使用提供商隐式缓存，具体块类型写入桥接日志。支持的位置映射到 GPT explicit 模式，费用和实际读写量以网关记录为准。count_tokens 返回 501，不提供虚构的跨模型精确计数。

请求认证、流式/非流式转换、首包前取消、流中取消、缓存用量及失败终止均有真实本地 HTTP 回归。桥接日志仅记录请求编号、耗时、状态与有限诊断，不保存提供商错误正文；失败响应不得伪装成 message_stop。`--through-bridge` 还核对真实 CLI 在第二轮回传工具结果和加密推理状态，费用网关请求数保持不变。

```sh
PYTHONPATH=. .velaros-workspace/bench/venv/bin/python scripts/agent/harbor/anthropic_bridge_test.py
PYTHONPATH=. .velaros-workspace/bench/venv/bin/python scripts/agent/harbor/claude-cli-probe.py --through-bridge
```

`claude-cli-probe.py --through-bridge --context-preflight` 用八轮真实工具执行和合成的大额 usage 触发原生自动整理，核对 compact_boundary 及整理后的任务完成。它验证整理控制与协议链路，不衡量真实长上下文解题质量。依照 [Claude Code 模型窗口配置](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id)，当前预检为未知模型 ID 显式配置 1,050,000 窗口、900,000 自动整理窗口，真实 HTTP 请求的输出上限为 32,768。CLI modelUsage 中的 maxOutputTokens 仍显示模型内置默认 32,000，报告必须区分该字段和实际请求。

付费 Claude Code＋GPT 协议桥批次必须另外冻结 CLI、转换器、SDK 和服务源码身份，登记模型窗口、输出限制及原生自动整理行为。服务启动入口为 `anthropic_bridge.py --directory .velaros-workspace/bench/campaign`，不能绕过共同费用账直接连接提供商。

后续准备的 bundle 会在 status.json 记录完整轨迹导出的次数、累计/最大耗时和写入字节数，并由报告保留为 harness_trace_export。该计时包括 trace 读取、序列化和 traces/ATIF 写入，不含 status 文件本身；用于诊断采集开销，任务耗时仍使用原始墙钟时间。旧 bundle 没有该字段时保持未知。


看图接入候选用 `prepare.mjs --project-images`，把正式 Runtime 的 `project.images` 开关写入 identity 和指纹，并将 `velaros:images` 作为常驻能力。真实 Runtime 回归确认项目 PNG 以多模态图片进入下一次模型请求。该项独立于结果租约参数，旧 bundle 的能力集合固定；图片相关开发题之外，还需检查常驻声明对文本任务费用、缓存和成绩的影响。

`prepare.mjs --resident-modules none` 将完整声明改为按需查询；也可指定 `project,shell,images` 的子集。此项传给 Runtime 现有 residentModules 配置并纳入 bundle 指纹；已启用的模块仍可通过 modules.describe 查询、import 和调用，图片能力仍由 --project-images 开启。真实 Runtime 回归覆盖项目/Shell/图片查询与图片进入下一轮请求。合成首帧检查中，默认系统提示为 27,737 字符，只有 Shell 常驻为 13,510 字符，全部按需查询为 4,797 字符。这些是字符量，真实 token、额外发现轮次和任务收益须另行付费验证。

## 执行包装器的本地回归

`cancellable_environment.py` 关闭 job control 后启动独立进程会话，由外层 wait 保留退出码；该路径兼容不提供 `--wait` 的 setsid。取消标记检查前注册 PID 清理，提前取消不遗留进程身份。下面的测试只启动本机隔离测试进程，不创建评测任务或调用模型：

```sh
PYTHONPATH=.:scripts/agent/harbor .velaros-workspace/bench/venv/bin/python -m unittest scripts.agent.harbor.cancellable_environment_test
```

测试覆盖输出、退出码、管道、提前取消、忽略 TERM 的子进程回收与独立服务保留。旧任务的执行文件摘要仍对应原版本；此本地修复的证据见历史回顾台账。


## 当前本地修复

[第 49 轮修复说明](LOCAL-FIXES.md)记录 ABI、增量轨迹、展示范围、编辑候选、工具环境与多目标统计的改动和验收。运行中诊断使用 `trace-progress.jsonl`（provisional），结束时生成 `traces.json` 和完整 `trajectory.json`。新的 [v2 轨迹产物](TRACE-ARTIFACTS.md)把重复调用证据无损保存在同目录 `trace-invocations.jsonl`，通过 JS/Python reader 还原全部原字段；旧原始格式仍可读取。`status.json.traceExport` 统计实体、增量记录及最终快照的累计写入量，`finalSnapshots` 给出完整物化次数；采集计时不直接作为任务加速结论。

musl 容器使用 `prepare-environment.py --libc musl`、`prepare-linux.py --bundle <新目录> --libc musl`、`prepare-codex.py --libc musl` 准备对应产物。新执行清单需冻结 `runtime_artifacts.py`；安装器在请求模型之前校验任务 libc 与归档元数据。Codex 私有 Node 仅用于启动 CLI，项目工具链由任务本身提供。
