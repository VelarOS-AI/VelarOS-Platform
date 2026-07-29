import type {
  CallbackTransportOptions,
  LogRecord,
  LogTransport,
  MemoryTransport,
  MemoryTransportOptions,
} from './types.js'

export function createCallbackTransport(options: CallbackTransportOptions): LogTransport {
  return {
    id: options.id ?? 'callback',
    enabled: options.enabled,
    minLevel: options.minLevel,
    accepts: options.accepts,
    write: options.write,
    flush: options.flush,
    dispose: options.dispose,
  }
}

export function createMemoryTransport(options: MemoryTransportOptions = {}): MemoryTransport {
  const records: LogRecord[] = []
  const limit = options.limit ?? 500

  return {
    id: options.id ?? 'memory',
    minLevel: options.minLevel,
    accepts: options.accepts,
    get records(): readonly LogRecord[] {
      return records
    },
    clear(): void {
      records.length = 0
    },
    write(record: LogRecord): void {
      records.push(record)
      if (records.length > limit) {
        records.splice(0, records.length - limit)
      }
    },
  }
}
