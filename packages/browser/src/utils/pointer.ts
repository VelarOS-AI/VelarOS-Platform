/**
 * 浏览器自动化的统一虚拟指针外观。
 *
 * 内置浏览器始终使用这枚紧凑箭头；外部浏览器的观察窗也复用它，实际外部页面则优先移动
 * 操作系统指针。常量同时供页面注入脚本和宿主预览 UI 使用，防止两处各画一份后逐渐漂移。
 */
export const BrowserFallbackVirtualPointer = Object.freeze({
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  // @arch-guard:suspend code-style/require-chinese-comments 理由：下一行是第三方图标的著作权归属，署名与许可证名必须逐字保留，翻译会使归属失效。
  // 取自 Pictogrammers Material Design Icons `cursor-default`（Apache-2.0）。
  // 采用经典系统箭头的短柄轮廓，避免宽大的导航箭头或带钩的光标造型。
  path: 'M13.64,21.97C13.14,22.21 12.54,22 12.31,21.5L10.13,16.76L7.62,18.78C7.45,18.92 7.24,19 7,19A1,1 0 0,1 6,18V3A1,1 0 0,1 7,2C7.24,2 7.47,2.09 7.64,2.23L7.65,2.22L19.14,11.86C19.57,12.22 19.62,12.85 19.27,13.27C19.12,13.45 18.91,13.57 18.7,13.61L15.54,14.23L17.74,18.96C18,19.46 17.76,20.05 17.26,20.28L13.64,21.97Z',
  fill: '#050505',
  stroke: '#ffffff',
  strokeWidth: 1.8,
  hotspotX: 7,
  hotspotY: 2,
  filter: 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.48))',
})

/** 页面注入脚本使用的无交互 SVG；所有动态位置和动画由外层元素承担。 */
export function buildBrowserFallbackVirtualPointerSvg(): string {
  const pointer = BrowserFallbackVirtualPointer
  // @arch-guard:suspend code-style/require-chinese-comments 理由：下面是 SVG 标记模板，不是说明文案；命名空间 URL 与属性名被启发式误判为英文散文。
  return `<svg width="${pointer.width}" height="${pointer.height}" viewBox="${pointer.viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${pointer.path}" fill="${pointer.fill}" stroke="${pointer.stroke}" stroke-width="${pointer.strokeWidth}" stroke-linejoin="round"/></svg>`
}
