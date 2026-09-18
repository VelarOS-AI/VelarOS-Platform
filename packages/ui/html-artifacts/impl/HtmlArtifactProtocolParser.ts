/**
 * 有状态的增量协议解析器：一条长流从头喂到尾，状态归它自己管。
 * 实例由 `htmlArtifactProtocol.createParser()` 给出；宿主要自己持久化状态时走那三个函数式方法。
 */
import type {
  HtmlArtifactProtocolEvent,
  HtmlArtifactProtocolStateSnapshot,
  HtmlArtifactProtocolStreamOptions,
  HtmlArtifactProtocolStreamState,
  HtmlArtifactSnapshot,
} from '../types/html-artifacts.js'
import {
  applyProtocolChunk,
  createProtocolStreamState,
  finalizeProtocolStream,
} from '../utils/protocol-stream.js'

/**
 * 一条流的解析器：喂文本进去、拿事件出来，解析到哪了看 `state`。
 * 一个解析器对一条流；同一个实例不要并发喂两条流，要接下一条先 `reset()`。
 */
export interface HtmlArtifactProtocolParserApi {
  /** 解析到哪了的只读快照：每一层都已冻结，外面看得见改不动。 */
  readonly state: HtmlArtifactProtocolStateSnapshot
  /** 喂一段文本进来，返回这一段能确定下来的事件；chunk 可以断在任意字符上。 */
  write: (chunk: string) => HtmlArtifactProtocolEvent[]
  /** 流结束时收尾：把攒着的内容发完，没收的制品一定会收到 `artifact-close`。 */
  finish: () => HtmlArtifactProtocolEvent[]
  /** 按 id 取一个制品的当前内容副本；没有这个制品就返回 null。 */
  getSnapshot: (artifactId: string) => Nullable<HtmlArtifactSnapshot>
  /** 丢掉全部状态，回到刚建出来的样子，好接下一条流。 */
  reset: () => void
}

export class HtmlArtifactProtocolParser implements HtmlArtifactProtocolParserApi {
  private currentState: HtmlArtifactProtocolStreamState

  constructor(private readonly options: HtmlArtifactProtocolStreamOptions = {}) {
    this.currentState = createProtocolStreamState(options)
  }

  public get state(): HtmlArtifactProtocolStateSnapshot {
    const artifactsById = Object.fromEntries(
      Object.entries(this.currentState.artifactsById).map(([id, artifact]) => [
        id,
        Object.freeze({ ...artifact }),
      ])
    )
    const activeAction = this.currentState.activeAction
      ? Object.freeze({
        ...this.currentState.activeAction,
        emittedDiagnostics: Object.freeze([...this.currentState.activeAction.emittedDiagnostics]),
      })
      : null
    return Object.freeze({
      ...this.currentState,
      activeArtifact: this.currentState.activeArtifact
        ? Object.freeze({ ...this.currentState.activeArtifact })
        : null,
      activeAction,
      artifactsById: Object.freeze(artifactsById),
      limits: Object.freeze({ ...this.currentState.limits }),
    })
  }

  public write(chunk: string): HtmlArtifactProtocolEvent[] {
    return applyProtocolChunk(this.currentState, chunk)
  }

  public finish(): HtmlArtifactProtocolEvent[] {
    return finalizeProtocolStream(this.currentState)
  }

  public getSnapshot(artifactId: string): Nullable<HtmlArtifactSnapshot> {
    const snapshot = this.currentState.artifactsById[artifactId]
    return snapshot ? { ...snapshot } : null
  }

  public reset(): void {
    this.currentState = createProtocolStreamState(this.options)
  }
}
