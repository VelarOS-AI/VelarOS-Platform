import { randomBytes } from 'node:crypto'

interface BrowserPageContentBoundary {
  source: 'browser-page-content'
  origin: string
  nonce: string
  fields: ['content']
}

function createBrowserPageContentBoundary(url: string): BrowserPageContentBoundary {
  return {
    source: 'browser-page-content',
    origin: resolveOrigin(url),
    nonce: randomBytes(8).toString('hex'),
    fields: ['content'],
  }
}

function resolveOrigin(url: string): string {
  if (!URL.canParse(url)) return url

  return new URL(url).origin
}

export { createBrowserPageContentBoundary }
export type { BrowserPageContentBoundary }
