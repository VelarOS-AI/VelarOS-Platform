/**
 * 探测器注册处：一套评测里用哪几个探测器、它们的阈值与工具名单是什么，全在一份注册表上。
 * 看门狗也从这里走，探测器发现与中止判定因此永远用同一组阈值。
 */
import { DefaultLoopThresholds } from '../contract/constants.js'
import type { RegisteredDetector } from '../contract/requires.js'
import type {
  BuiltinDetectorOptions,
  DetectorContext,
  Finding,
  Observation,
  WatchdogAbort,
  WatchdogBaseline,
} from '../types/agent-lab.js'
import type { ResolvedDetectorSettings } from '../types/internal.js'
import { createBuiltinDetectors } from '../utils/measure/detectors.js'
import { createWatchdogBaseline, selectAbortCandidate } from '../utils/measure/watchdog.js'

/**
 * 一套评测的探测器注册处。同一个 id 只许注册一次；跑探测时按探测器自述的阶段与观测面过滤，
 * 看不到的那一面不出判词（不是出「通过」）。看门狗的基线与中止判定也由它给，用的是同一份阈值与工具名单。
 * 实例归调用方，一套评测一份，进程里可以有很多份。
 */
export interface DetectorRegistryApi {
  /** 注册一个探测器；id 重复当场报错。 */
  register: (detector: RegisteredDetector) => void
  /** 注册十三个内置探测器；阈值只写要改的那几项，两份工具名单由宿主给，不给就不出对应判词。 */
  registerBuiltins: (options?: BuiltinDetectorOptions) => void
  /** 按 id 取一个探测器；没有就是 `null`。 */
  get: (id: string) => RegisteredDetector | null
  /** 列出全部探测器，按 id 排序。 */
  list: () => readonly RegisteredDetector[]
  /** 跑一遍探测：阶段不匹配、观测面是 `none` 的探测器跳过。 */
  detect: (observation: Observation, context: DetectorContext) => readonly Finding[]
  /** 进一次等待窗口前记基线：窗口内只看增量，上一段攒的次数不算进来。 */
  watchdogBaseline: (
    observation: Observation,
    findings: readonly Finding[],
    activeDetectorIds: ReadonlySet<string>
  ) => WatchdogBaseline
  /** 看这一刻要不要掐断；不用掐就是 `null`。 */
  watchdogAbort: (
    observation: Observation,
    findings: readonly Finding[],
    baseline: WatchdogBaseline,
    activeDetectorIds: ReadonlySet<string>
  ) => WatchdogAbort | null
}

class DetectorRegistry implements DetectorRegistryApi {
  private readonly detectors = new Map<string, RegisteredDetector>()

  private settings: ResolvedDetectorSettings = {
    thresholds: DefaultLoopThresholds,
    catalogToolNames: [],
    interactiveToolNames: [],
  }

  public register(detector: RegisteredDetector): void {
    if (this.detectors.has(detector.definition.id)) {
      throw new Error(`这个探测器已经注册过了: ${detector.definition.id}`)
    }
    this.detectors.set(detector.definition.id, detector)
  }

  public registerBuiltins(options: BuiltinDetectorOptions = {}): void {
    this.settings = {
      thresholds: { ...DefaultLoopThresholds, ...options.thresholds },
      catalogToolNames: options.catalogToolNames ?? [],
      interactiveToolNames: options.interactiveToolNames ?? [],
    }
    for (const detector of createBuiltinDetectors(this.settings)) this.register(detector)
  }

  public get(id: string): RegisteredDetector | null {
    return this.detectors.get(id) ?? null
  }

  public list(): readonly RegisteredDetector[] {
    return [...this.detectors.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id)
    )
  }

  public detect(observation: Observation, context: DetectorContext): readonly Finding[] {
    const findings: Finding[] = []
    for (const detector of this.list()) {
      const { definition } = detector
      if (!definition.phases.includes(observation.phase)) continue
      if (observation.coverage[definition.face] === 'none') continue
      findings.push(...detector.detect(observation, context))
    }
    return findings
  }

  public watchdogBaseline(
    observation: Observation,
    findings: readonly Finding[],
    activeDetectorIds: ReadonlySet<string>
  ): WatchdogBaseline {
    return createWatchdogBaseline(observation, findings, activeDetectorIds, this.settings)
  }

  public watchdogAbort(
    observation: Observation,
    findings: readonly Finding[],
    baseline: WatchdogBaseline,
    activeDetectorIds: ReadonlySet<string>
  ): WatchdogAbort | null {
    return selectAbortCandidate(observation, findings, baseline, activeDetectorIds, this.settings)
  }
}

/** 开一份空的探测器注册处；要内置探测器就再调一次 `registerBuiltins`。 */
export function createDetectorRegistry(): DetectorRegistryApi {
  return new DetectorRegistry()
}
