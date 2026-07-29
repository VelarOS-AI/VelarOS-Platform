/**
 * Stateful retention is no longer inferred from concrete tool names.
 * Capability packages should contribute durable state through context collectors.
 */
function isStatefulToolResultName(_toolName: string): boolean {
  return false
}

export { isStatefulToolResultName }
