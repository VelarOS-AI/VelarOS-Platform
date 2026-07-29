class PresentationPath {
  public isAbsolutePathText(path: string): boolean {
    const normalized = path.trim()
    return normalized.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(normalized) || /^\\\\/u.test(normalized)
  }

  public stripLeadingPathTextSeparators(path: string): string {
    return path.replace(/^[\\/]+/gu, '')
  }

  public normalizePathTextForComparison(path: string): string {
    const normalized = path.trim().replace(/\\/gu, '/')
    return normalized === '/' ? normalized : normalized.replace(/\/+$/gu, '')
  }

  public getPathTextBaseName(path: string): string {
    const normalized = this.normalizePathTextForComparison(path)
    return normalized.split('/').filter(Boolean).at(-1) ?? normalized
  }

  public joinPathText(rootPath: string, ...segments: string[]): string {
    const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/'
    const root = rootPath.replace(/[\\/]+$/gu, '')
    const suffix = segments
      .map((segment) => segment.trim().replace(/^[\\/]+|[\\/]+$/gu, ''))
      .filter(Boolean)
      .join(separator)
    return suffix ? `${root}${separator}${suffix}` : root
  }
}

export const platformCompatibility = new PresentationPath()
