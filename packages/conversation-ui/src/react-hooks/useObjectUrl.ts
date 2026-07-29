import { useEffect, useState } from 'react'

/** 为二进制对象创建对象地址，并在替换或卸载时释放。 */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }

    const nextUrl = URL.createObjectURL(blob)
    setUrl(nextUrl)

    return () => {
      URL.revokeObjectURL(nextUrl)
    }
  }, [blob])

  return url
}

/** 为二进制对象列表创建对象地址；列表变化或卸载时释放旧地址。 */
export function useObjectUrls(blobs: readonly Blob[]): string[] {
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    const nextUrls = blobs.map((blob) => URL.createObjectURL(blob))
    setUrls(nextUrls)

    return () => {
      nextUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [blobs])

  return urls
}
