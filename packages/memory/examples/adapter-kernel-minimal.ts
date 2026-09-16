import {
  type MemoryAdapterMountInput,
  mountMemoryAdapter,
} from '../src/exports/adapter-kernel'

declare const input: MemoryAdapterMountInput

const adapter = mountMemoryAdapter(input)

await adapter.service?.warmup()
const source = adapter.turnRecall.createTurnContextSource()

void source
