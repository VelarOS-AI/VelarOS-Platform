import {
  MemoryAdapterRuntime,
  type MountMemoryAdapterInput,
} from '../src/adapter-kernel'

declare const input: MountMemoryAdapterInput

const adapter = new MemoryAdapterRuntime(input)

await adapter.service?.warmup()
const source = adapter.turnRecall.createTurnContextSource()

void source
