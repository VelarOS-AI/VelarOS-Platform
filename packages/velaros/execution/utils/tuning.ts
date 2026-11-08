/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（错误码、环境变量、模型看得见的上限）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按用途分组、每项一句说明；实现里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（危险命令名单、敏感路径名单、搜索跳过的目录）跟着规则写在各自的 utils 文件里；算法与格式里的数字（哈希取几位、编码判定的比例）就地写。
 */

/** 本机跑命令的可调参数，按用途分组。 */
export const ShellTuning = Object.freeze({
  /** 跑命令与后台任务：ShellCommandRunner、LocalShellHost、命令回执。 */
  command: Object.freeze({
    /** 命令没给 timeoutMs 时的超时，毫秒；上限是 `execution 宿主` 的 ShellLimits.timeoutMs。 */
    timeoutMs: 120_000,
    /** 命令没给 maxOutputChars 时 stdout、stderr 各返回末尾多少字符；上限是 ShellLimits.outputChars。 */
    outputChars: 50_000,
    /** 已结束的后台任务最多留多少条，超过从最早结束的删起，进程句柄一起释放。 */
    finishedTasks: 200,
    /** 交互式任务的控制台缓冲区保留多少字符；再往前的输出被挤掉，读的时候如实报告丢了多少。 */
    consoleBufferChars: 100_000,
    /** 往控制台写输入最多等多少毫秒：进程到期还没读走就报「已排队」返回，不让调用方一直挂着。 */
    consoleWriteTimeoutMs: 2_000,
    /** 伪终端的初始列数；界面量好尺寸后再改。 */
    consoleColumns: 120,
    /** 伪终端的初始行数。 */
    consoleRows: 30,
    /** 验证摘要里从失败输出末尾摘多少字符。 */
    verificationIssueChars: 1_000,
    /** 危险命令确认卡的标题里命令最多摆多少字符；再长的截断，要看全文的人看命令本身。 */
    confirmationCommandChars: 120,
  }),
  /** 受管子进程：ShellProcessManager、ShellManagedProcess、进程控制用的短命令。 */
  process: Object.freeze({
    /** 已结束的进程最多保留多少条回执。 */
    completedProcesses: 512,
    /** 直接子进程退出后，等后代放开输出管道的最长毫秒数。 */
    drainTimeoutMs: 1_000,
    /** 发出终止信号后，补发 SIGKILL 之前的宽限毫秒数。 */
    terminateGraceMs: 500,
    /** 从开始终止到放弃等待、按清理不完整收尾的最长毫秒数。 */
    terminationDeadlineMs: 5_000,
    /** 等子进程真正起来（spawn 事件）的最长毫秒数。 */
    spawnTimeoutMs: 2_000,
    /** 进程控制用的短命令（查进程启动时刻等）的超时毫秒数。 */
    controlTimeoutMs: 2_000,
    /** 进程控制用的短命令最多收多少字节的输出。 */
    controlOutputBytes: 32 * 1024,
  }),
  /** shell 选择与自检：ShellResolver。 */
  shell: Object.freeze({
    /** POSIX 登录交互 shell 读取环境的最长毫秒数。 */
    environmentCaptureTimeoutMs: 10_000,
    /** 登录环境输出的字节上限，包括启动脚本的输出。 */
    environmentOutputBytes: 2 * 1024 * 1024,
    /** shell 自检、查某个命令在不在的超时毫秒数。 */
    probeTimeoutMs: 2_500,
    /** Windows 上重读用户与系统环境变量的超时毫秒数。 */
    environmentRefreshTimeoutMs: 3_000,
    /** 自检这类短命令退出后等管道的毫秒数，比普通命令短。 */
    captureDrainTimeoutMs: 250,
    /** 自检这类短命令终止时补发 SIGKILL 前的宽限毫秒数。 */
    captureTerminateGraceMs: 100,
    /** 自检这类短命令从开始终止到放弃等待的最长毫秒数。 */
    captureTerminationDeadlineMs: 1_000,
    /** 自检这类短命令最多留多少字符的 stdout。 */
    captureStdoutChars: 65_536,
    /** 自检这类短命令最多留多少字符的 stderr。 */
    captureStderrChars: 8_192,
  }),
  /** 读系统信息：进程、端口与资源快照（LocalShellHost、平台命令）。 */
  systemInfo: Object.freeze({
    /** 读系统信息的平台命令（ps、lsof、netstat 等）的超时毫秒数。 */
    commandTimeoutMs: 2_000,
    /** 读系统信息的平台命令最多收多少字节的输出。 */
    commandOutputBytes: 8 * 1024 * 1024,
    /** 列进程、列端口没给 limit 时返回多少条。 */
    listItems: 50,
    /** 资源快照里附几个最占资源的进程。 */
    topProcesses: 5,
    /** 资源快照的定级阈值（百分比）：到 warn 算偏高，到 high 算过高。 */
    levels: Object.freeze({
      /** CPU 占用。 */
      cpu: Object.freeze({
        /** 到这个百分比算偏高。 */
        warn: 60,
        /** 到这个百分比算过高。 */
        high: 85,
      }),
      /** 内存占用。 */
      memory: Object.freeze({
        /** 到这个百分比算偏高。 */
        warn: 75,
        /** 到这个百分比算过高。 */
        high: 90,
      }),
      /** swap 占用。 */
      swap: Object.freeze({
        /** 到这个百分比算偏高。 */
        warn: 35,
        /** 到这个百分比算过高。 */
        high: 60,
      }),
      /** 磁盘占用。 */
      disk: Object.freeze({
        /** 到这个百分比算偏高。 */
        warn: 80,
        /** 到这个百分比算过高。 */
        high: 90,
      }),
      /** 一分钟平均负载，按每个核算成百分比。 */
      load: Object.freeze({
        /** 到这个百分比算偏高。 */
        warn: 80,
        /** 到这个百分比算过高。 */
        high: 120,
      }),
    }),
  }),
})
