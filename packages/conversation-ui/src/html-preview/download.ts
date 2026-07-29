import { TimerScope } from '#internal/timerScope'

const DEFAULT_TEXT_MIME = 'text/plain;charset=utf-8'
const downloadTimers = new TimerScope({ name: 'download.utils' })

export type DownloadBlobOptions = {
  revokeDelayMs?: number
}

export type DownloadTextFileOptions = DownloadBlobOptions & {
  mimeType?: string
}

export function downloadBlob(filename: string, blob: Blob, options?: DownloadBlobOptions): void {
  const revokeDelayMs = options?.revokeDelayMs ?? 0
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  downloadTimers.after(revokeDelayMs, () => URL.revokeObjectURL(url), {
    label: `download.revokeObjectUrl:${filename}`,
  })
}

export function downloadTextFile(
  filename: string,
  text: string,
  options?: DownloadTextFileOptions
): void {
  const blob = new Blob([text], {
    type: options?.mimeType ?? DEFAULT_TEXT_MIME,
  })
  downloadBlob(filename, blob, { revokeDelayMs: options?.revokeDelayMs })
}
