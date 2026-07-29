/** 构造同视图导航 bridge，拦截 target=_blank 链接和 window.open。 */
function buildSameViewNavigationBridgeScript(): string {
  return `(() => {
  const bridgeKey = '__velaros_same_view_navigation_bridge__';
  if (window[bridgeKey]) return true;
  Object.defineProperty(window, bridgeKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const resolveNavigableUrl = (rawUrl) => {
    if (!rawUrl) return null;
    const value = String(rawUrl).trim();
    if (!value || value.toLowerCase().startsWith('javascript:')) return null;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  const shouldRouteInCurrentView = (rawUrl, rawTarget) => {
    const url = resolveNavigableUrl(rawUrl);
    if (!url) return null;
    const target = String(rawTarget || '').trim().toLowerCase();
    return target === '_blank' || target === '_new' || target === 'blank' ? url : null;
  };

  const routeInCurrentView = (url) => {
    window.location.assign(url);
  };

  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = event.target;
    const anchor = target && typeof target.closest === 'function'
      ? target.closest('a[href]')
      : null;
    if (!anchor || anchor.hasAttribute('download')) return;

    const baseTarget = document.querySelector('base[target]')?.getAttribute('target') || '';
    const nextUrl = shouldRouteInCurrentView(
      anchor.getAttribute('href') || anchor.href,
      anchor.getAttribute('target') || baseTarget
    );
    if (!nextUrl) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    routeInCurrentView(nextUrl);
  }, true);

  const nativeWindowOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const nextUrl = shouldRouteInCurrentView(url, target || '_blank');
    if (nextUrl) {
      routeInCurrentView(nextUrl);
      return null;
    }

    return nativeWindowOpen(url, target, features);
  };

  return true;
})()`
}

export { buildSameViewNavigationBridgeScript }
