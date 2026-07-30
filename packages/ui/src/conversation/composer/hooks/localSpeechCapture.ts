const TargetSampleRate = 16_000
const ScriptProcessorBufferSize = 4_096
const Base64ChunkSize = 0x8000

function downsampleMono(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === TargetSampleRate) return input

  const ratio = inputSampleRate / TargetSampleRate
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio)
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio))
    let sum = 0
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex] ?? 0
    output[outputIndex] = end > start ? sum / (end - start) : 0
  }
  return output
}

function encodePcm16Wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeText(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TargetSampleRate, true)
  view.setUint32(28, TargetSampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += Base64ChunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + Base64ChunkSize))
  }
  return btoa(binary)
}

/** 浏览器麦克风采集器：只产出 whisper-cli 可直接读取的 16 kHz PCM WAV。 */
class LocalSpeechCapture {
  private readonly chunks: Float32Array[] = []
  private stopped = false

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
    private readonly silentSink: GainNode
  ) {}

  public static async start(): Promise<LocalSpeechCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    // 拿到 stream 之后、capture 构造成功之前的**任何**抛出都必须把麦克风轨道关掉：
    // 这段区间里没有实例可供调用方 stop()，调用方的 catch 只能报错、够不着 stream。
    // 漏掉 = 系统录音指示灯常亮、麦克风被占用，且用户无从关闭（§2.4 失败方向）。
    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(ScriptProcessorBufferSize, 1, 1)
      const silentSink = context.createGain()
      silentSink.gain.value = 0

      const capture = new LocalSpeechCapture(stream, context, source, processor, silentSink)
      processor.onaudioprocess = (event) => {
        capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(silentSink)
      silentSink.connect(context.destination)
      await context.resume()
      return capture
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      throw error
    }
  }

  public async stop(): Promise<string> {
    if (this.stopped) return ''
    this.stopped = true
    const samples = this.mergeChunks()
    const inputSampleRate = this.context.sampleRate
    await this.release()
    return bytesToBase64(encodePcm16Wav(downsampleMono(samples, inputSampleRate)))
  }

  public async abort(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.release()
  }

  private mergeChunks(): Float32Array {
    const totalLength = this.chunks.reduce((total, chunk) => total + chunk.length, 0)
    const samples = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return samples
  }

  private async release(): Promise<void> {
    this.processor.onaudioprocess = null
    this.source.disconnect()
    this.processor.disconnect()
    this.silentSink.disconnect()
    for (const track of this.stream.getTracks()) track.stop()
    await this.context.close()
  }
}

export { LocalSpeechCapture }
