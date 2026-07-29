import type {
  ComputerCommand,
  ComputerHelperRequest,
  ComputerHelperResponse,
} from './types'

/**
 * Pure encode/decode helpers for the line-delimited JSON stdio protocol spoken
 * by the Python desktop-control helpers. Kept side-effect free so the wire
 * format can be unit-tested without spawning a real sidecar.
 */

/** Encode a request into a single newline-terminated JSON line. */
export function encodeComputerRequest(
  id: number,
  command: ComputerCommand,
  payload: Record<string, unknown> = {}
): string {
  const request: ComputerHelperRequest = { id, command, payload }
  return `${JSON.stringify(request)}\n`
}

/**
 * Decode one helper response line. Throws on malformed JSON or a payload that
 * does not match the `{ok: boolean, ...}` envelope, so callers never have to
 * defensively re-validate the shape.
 */
export function decodeComputerResponse<TResult = unknown>(
  line: string
): ComputerHelperResponse<TResult> {
  const trimmed = line.trim()
  if (!trimmed) {
    throw new Error('Empty computer-helper response line')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(
      `Invalid computer-helper response JSON: ${(error as Error).message}`
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Computer-helper response is not an object')
  }

  const record = parsed as Record<string, unknown>
  const id = typeof record.id === 'number' ? record.id : null

  if (record.ok === true) return { id, ok: true, result: record.result as TResult }

  if (record.ok === false) {
    const error =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {}
    return {
      id,
      ok: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'helper_error',
        message:
          typeof error.message === 'string'
            ? error.message
            : 'Unknown computer-helper error',
      },
    }
  }

  throw new Error('Computer-helper response missing boolean "ok" field')
}

/**
 * Split a streaming stdout buffer into complete JSON lines. Returns the decoded
 * complete lines and the trailing partial fragment to carry into the next read.
 */
export function drainResponseLines(buffer: string): {
  lines: string[]
  rest: string
} {
  const segments = buffer.split('\n')
  const rest = segments.pop() ?? ''
  const lines = segments.map((segment) => segment.trim()).filter(Boolean)
  return { lines, rest }
}
