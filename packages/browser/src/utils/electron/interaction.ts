/** 内嵌页面交互里用不着实例状态的那部分。 */

import type { BrowserPointerPoint } from '../../types/runtime.js'
import { BrowserFallbackVirtualPointer, buildBrowserFallbackVirtualPointerSvg } from '../pointer'

/** 拼一段在页面里画虚拟鼠标轨迹的脚本。 */
export function buildVirtualPointerScript(
  path: BrowserPointerPoint[],
  pressed: boolean,
  durationMs: number
): string {
  const pointerAppearance = BrowserFallbackVirtualPointer
  const pointerSvg = buildBrowserFallbackVirtualPointerSvg()
  const payload = JSON.stringify({
    path,
    pressed,
    durationMs,
  })

  return `(() => {
const payload = ${payload};
const pointerId = '__velaros_virtual_pointer__';
const motionKey = '__velaros_virtual_pointer_motion__';
const hotspotX = ${pointerAppearance.hotspotX};
const hotspotY = ${pointerAppearance.hotspotY};
let pointer = document.getElementById(pointerId);
if (!pointer) {
  pointer = document.createElement('div');
  pointer.id = pointerId;
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '${pointerSvg}';
  Object.assign(pointer.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '${pointerAppearance.width}px',
    height: '${pointerAppearance.height}px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '1',
    transformOrigin: hotspotX + 'px ' + hotspotY + 'px',
    transition: 'opacity 110ms ease',
    filter: '${pointerAppearance.filter}'
  });
  (document.body || document.documentElement).appendChild(pointer);
}
const points = Array.isArray(payload.path) ? payload.path : [];
const lastPoint = points[points.length - 1];
if (!lastPoint) return false;
const glyph = pointer.querySelector('svg');
const motion = window[motionKey] || (window[motionKey] = {});
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
motion.generation = Number(motion.generation || 0) + 1;
const generation = motion.generation;
if (motion.idleTimer) clearTimeout(motion.idleTimer);

const cancelGlyphAnimations = () => {
  if (!glyph?.getAnimations) return;
  for (const animation of glyph.getAnimations()) animation.cancel();
};
const animateGlyph = (frames, options) => {
  if (reducedMotion || !glyph?.animate) return;
  cancelGlyphAnimations();
  glyph.animate(frames, options);
};
const scheduleIdleWiggle = () => {
  if (reducedMotion || !glyph) return;
  const clickRemaining = Math.max(0, Number(motion.clickUntil || 0) - performance.now());
  const wiggle = () => {
    if (motion.generation !== generation || !pointer.isConnected) return;
    animateGlyph(
      [
        { transform: 'translate(0, 0) rotate(0deg)' },
        { transform: 'translate(-0.2px, 0.15px) rotate(-2.2deg)', offset: 0.3 },
        { transform: 'translate(0.2px, -0.1px) rotate(1.8deg)', offset: 0.62 },
        { transform: 'translate(-0.05px, 0) rotate(-0.7deg)', offset: 0.82 },
        { transform: 'translate(0, 0) rotate(0deg)' },
      ],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
    motion.idleTimer = setTimeout(wiggle, 4200);
  };
  motion.idleTimer = setTimeout(wiggle, 3400 + clickRemaining);
};
const setPointer = (point) => {
  pointer.style.transform =
    'translate(' + (point.x - hotspotX) + 'px, ' + (point.y - hotspotY) + 'px)';
  pointer.dataset.x = String(point.x);
  pointer.dataset.y = String(point.y);
};
const now = performance.now();
const clickAnimationActive = Number(motion.clickUntil || 0) > now;
if (payload.pressed) {
  motion.clickUntil = now + 260;
  animateGlyph(
    [
      { transform: 'scale(1) rotate(0deg)' },
      { transform: 'scale(0.88) rotate(-1.8deg)', offset: 0.34 },
      { transform: 'scale(1.035) rotate(0.8deg)', offset: 0.72 },
      { transform: 'scale(1) rotate(0deg)' },
    ],
    { duration: 260, easing: 'cubic-bezier(0.2, 0.85, 0.2, 1)' }
  );
} else if (points.length > 1) {
  motion.clickUntil = 0;
  animateGlyph(
    [
      { transform: 'scale(0.985) rotate(-1.1deg)' },
      { transform: 'scale(1) rotate(0deg)' },
    ],
    { duration: 180, easing: 'cubic-bezier(0.18, 0.75, 0.2, 1)' }
  );
} else if (!clickAnimationActive) {
  cancelGlyphAnimations();
}
scheduleIdleWiggle();
if (points.length === 1 || payload.durationMs <= 0) {
  setPointer(lastPoint);
  return true;
}

const ease = (value) => 1 - Math.pow(1 - value, 3);
const duration = payload.durationMs;
const startedAt = performance.now();
return new Promise((resolve) => {
  const frame = () => {
    const rawProgress = Math.min(1, (performance.now() - startedAt) / duration);
    const segmentPosition = rawProgress * (points.length - 1);
    const segmentIndex = Math.min(points.length - 2, Math.floor(segmentPosition));
    const localProgress = ease(segmentPosition - segmentIndex);
    const current = points[segmentIndex];
    const next = points[segmentIndex + 1];
    setPointer({
      x: Math.round(current.x + (next.x - current.x) * localProgress),
      y: Math.round(current.y + (next.y - current.y) * localProgress),
    });
    if (rawProgress < 1) {
      requestAnimationFrame(frame);
      return;
    }
    setPointer(lastPoint);
    resolve(true);
  };
  frame();
});
})()`
}

/** 拼一段在页面里短暂显示当前缩放比例的脚本。 */
export function buildPageZoomHudScript(zoomFactor: number): string {
  const percent = Math.round(zoomFactor * 100)

  return `(() => {
const id = '__velaros_page_zoom_hud__';
const existing = document.getElementById(id);
if (existing) existing.remove();
const hud = document.createElement('div');
hud.id = id;
hud.setAttribute('aria-hidden', 'true');
hud.textContent = '${percent}%';
Object.assign(hud.style, {
  position: 'fixed',
  top: '14px',
  right: '14px',
  zIndex: '2147483647',
  minWidth: '56px',
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 12px',
  borderRadius: '8px',
  background: '#ffffff',
  color: '#111111',
  font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  boxShadow: '0 10px 28px rgba(15, 15, 15, 0.16), inset 0 0 0 1px rgba(15, 15, 15, 0.08)',
  pointerEvents: 'none',
  opacity: '1',
  transition: 'opacity 180ms ease, transform 180ms ease',
});
(document.body || document.documentElement).appendChild(hud);
window.setTimeout(() => {
  hud.style.opacity = '0';
  hud.style.transform = 'translateY(-4px)';
  window.setTimeout(() => hud.remove(), 220);
}, 2200);
return true;
})()`
}
