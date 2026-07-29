export interface LiveTextRendererModeInput {
  isStreaming: boolean
  animateStreamingText: boolean
  hasRenderedLiveText: boolean
}

export function shouldUseLiveTextRenderer({
  isStreaming,
  animateStreamingText,
  hasRenderedLiveText,
}: LiveTextRendererModeInput): boolean {
  return isStreaming || animateStreamingText || hasRenderedLiveText
}
