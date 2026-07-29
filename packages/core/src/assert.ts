import { AppError, type ErrorContext } from './error'
import { isPresent } from './typeGuards'

export function assertInvariant(
  condition: unknown,
  message: string,
  context: ErrorContext = {}
): asserts condition {
  if (!condition) {
    throw new AppError('INVARIANT', message, undefined, context)
  }
}

export function assertPresent<T>(
  value: T,
  message: string,
  context: ErrorContext = {}
): asserts value is NonNullable<T> {
  if (!isPresent(value)) {
    throw new AppError('ASSERTION', message, undefined, context)
  }
}

export function required<T>(
  value: T,
  message: string,
  context: ErrorContext = {}
): NonNullable<T> {
  assertPresent(value, message, context)
  return value
}
