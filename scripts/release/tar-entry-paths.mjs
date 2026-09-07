export const normalizeTarEntryPaths = (output) => output
  .split(/\r?\n/u)
  .map((entry) => entry.replaceAll('\\', '/'))
  .filter(Boolean)
