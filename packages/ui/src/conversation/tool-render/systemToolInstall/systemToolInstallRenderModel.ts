function normalizeCompactPart(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function buildSystemToolInstallCompactLine(
  parts: ReadonlyArray<LooseOptional<string>>
): string {
  const seen = new Set<string>()
  const compactParts: string[] = []

  for (const part of parts) {
    if (!part) continue

    const normalized = normalizeCompactPart(part)
    if (!normalized || seen.has(normalized)) continue

    seen.add(normalized)
    compactParts.push(part.trim())
  }

  return compactParts.join(' · ')
}
