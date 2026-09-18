/**
 * 增量协议这件能力的唯一出口：建状态、喂 chunk、收尾，以及要一个自己管状态的解析器。
 * 实例是 `htmlArtifactProtocol`，本身没有状态——状态要么在调用方手里，要么在解析器里。
 */
import type {
  HtmlArtifactProtocolEvent,
  HtmlArtifactProtocolStreamOptions,
  HtmlArtifactProtocolStreamState,
} from '../types/html-artifacts.js'
import {
  applyProtocolChunk,
  createProtocolStreamState,
  finalizeProtocolStream,
} from '../utils/protocol-stream.js'

import type { HtmlArtifactProtocolParserApi } from './HtmlArtifactProtocolParser.js'
import { HtmlArtifactProtocolParser } from './HtmlArtifactProtocolParser.js'

/**
 * HTML 制品增量协议的能力面：把模型吐出来的文本流解析成可以直接渲染的事件。
 * 两种用法二选一——宿主自己持久化状态（聊天会话跨进程续读正是这样）就用前三个方法，
 * 只是在一个页面里跑一条流就用 `createParser()`。实例归本包，进程里只有一份。
 */
export interface HtmlArtifactProtocolApi {
  /** 新建一条流的解析状态；续读时可以把已有的制品放回去。状态是纯数据，宿主可以自己存。 */
  createState: (options?: HtmlArtifactProtocolStreamOptions) => HtmlArtifactProtocolStreamState
  /** 把一段文本喂给某个状态，返回这一段能确定下来的事件；就地改这个状态。 */
  applyChunk: (
    state: HtmlArtifactProtocolStreamState,
    chunk: string,
  ) => HtmlArtifactProtocolEvent[]
  /** 流结束时收尾某个状态：把攒着的内容发完，没收的制品一定会收到 `artifact-close`。 */
  finalize: (state: HtmlArtifactProtocolStreamState) => HtmlArtifactProtocolEvent[]
  /** 要一个自己管状态的解析器，长流用它比自己端着状态省事。 */
  createParser: (options?: HtmlArtifactProtocolStreamOptions) => HtmlArtifactProtocolParserApi
}

class HtmlArtifactProtocol implements HtmlArtifactProtocolApi {
  public createState(
    options: HtmlArtifactProtocolStreamOptions = {}
  ): HtmlArtifactProtocolStreamState {
    return createProtocolStreamState(options)
  }

  public applyChunk(
    state: HtmlArtifactProtocolStreamState,
    chunk: string
  ): HtmlArtifactProtocolEvent[] {
    return applyProtocolChunk(state, chunk)
  }

  public finalize(state: HtmlArtifactProtocolStreamState): HtmlArtifactProtocolEvent[] {
    return finalizeProtocolStream(state)
  }

  public createParser(
    options: HtmlArtifactProtocolStreamOptions = {}
  ): HtmlArtifactProtocolParserApi {
    return new HtmlArtifactProtocolParser(options)
  }
}

export const htmlArtifactProtocol: HtmlArtifactProtocolApi = new HtmlArtifactProtocol()
