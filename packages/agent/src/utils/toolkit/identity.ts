/** Canonical model-tool identity shared by manifests, registries, and transports. */
const CanonicalToolIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9_-]*$/

function isCanonicalToolId(value: string): boolean {
  return CanonicalToolIdPattern.test(value)
}

function assertCanonicalToolId(value: string): void {
  if (!isCanonicalToolId(value))
    throw new Error(
      `invalid canonical tool id "${value}"; expected namespace:tool using lowercase letters, digits, dot, dash and underscore`
    )
}

export { assertCanonicalToolId, CanonicalToolIdPattern, isCanonicalToolId }
