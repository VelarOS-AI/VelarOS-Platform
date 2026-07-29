import type { BrowserDragOptions } from './types'

/** 构造拖拽 source/target 的坐标解析脚本。 */
class BrowserDragTargetScriptBuilder {
  public buildDragTargetScript(options: BrowserDragOptions): string {
    const payload = JSON.stringify({
      source: options.source,
      target: options.target,
    })

    return `(() => {
      const __velaros_drag_targets__ = true;
      void __velaros_drag_targets__;
      const payload = ${payload};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
        return String(value).replace(/["\\\\]/g, '\\\\$&');
      };
      const quoteAttr = (value) => String(value).replace(/["\\\\]/g, '\\\\$&');
      const tryQuery = (selector) => {
        if (!selector) return null;
        try {
          return document.querySelector(selector);
        } catch {
          return null;
        }
      };
      const addAttributeSelector = (selectors, tagName, attr, value) => {
        if (!value) return;
        selectors.push((tagName || '') + '[' + attr + '="' + quoteAttr(value) + '"]');
      };
      const inferRole = (node) => {
        const explicitRole = normalize(node.getAttribute('role')).toLowerCase();
        if (explicitRole) return explicitRole;
        const tagName = node.tagName.toLowerCase();
        if (tagName === 'button') return 'button';
        if (tagName === 'a' && node.hasAttribute('href')) return 'link';
        if (tagName === 'select') return 'combobox';
        if (tagName === 'option') return 'option';
        if (tagName === 'textarea') return 'textbox';
        if (tagName === 'input') {
          const type = normalize(node.getAttribute('type')).toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit') return 'submit';
          if (type === 'button') return 'button';
          return 'textbox';
        }
        return '';
      };
      const elementText = (node) => normalize(
        node.textContent
        || node.getAttribute('aria-label')
        || node.getAttribute('name')
        || node.getAttribute('placeholder')
        || node.getAttribute('value')
      );
      const resolveElement = (target) => {
        const attributes = target.attributes || {};
        const selectors = [];
        if (target.css) selectors.push(target.css);
        if (attributes.id) selectors.push('#' + escapeCss(attributes.id));
        addAttributeSelector(selectors, '', 'data-testid', attributes['data-testid']);
        addAttributeSelector(selectors, '', 'data-test', attributes['data-test']);
        addAttributeSelector(selectors, '', 'data-qa', attributes['data-qa']);
        addAttributeSelector(selectors, '', 'name', attributes.name || target.name);
        addAttributeSelector(selectors, '', 'aria-label', attributes['aria-label']);

        let element = null;
        let matchedSelector = null;
        for (const selector of selectors) {
          element = tryQuery(selector);
          if (element) {
            matchedSelector = selector;
            break;
          }
        }

        if (!element) {
          const targetText = normalize(target.text || target.name).toLowerCase();
          const targetRole = normalize(target.role).toLowerCase();
          const candidates = Array.from(document.querySelectorAll('button,input,textarea,select,a[href],[draggable="true"],[role],[data-testid],[data-test],[data-qa],[contenteditable="true"],[contenteditable=""]'));
          element = candidates.find((candidate) => {
            const text = elementText(candidate).toLowerCase();
            const role = inferRole(candidate);
            if (targetRole && role !== targetRole) return false;
            if (targetText && !text.includes(targetText)) return false;
            return Boolean(targetRole || targetText);
          }) || null;
        }

        if (!(element instanceof Element)) {
          return {
            matched: false,
            selector: target.css || null,
            text: null,
            point: null,
          };
        }

        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const left = Math.max(rect.left, 0);
        const right = Math.min(rect.right, viewportWidth);
        const top = Math.max(rect.top, 0);
        const bottom = Math.min(rect.bottom, viewportHeight);
        const point = right > left && bottom > top
          ? { x: (left + right) / 2, y: (top + bottom) / 2 }
          : null;

        return {
          matched: point !== null,
          selector: matchedSelector || target.css || null,
          text: elementText(element) || null,
          point,
        };
      };

      const source = resolveElement(payload.source);
      const target = resolveElement(payload.target);
      const failureReason = !source.matched
        ? 'source-not-found'
        : !target.matched
          ? 'target-not-found'
          : null;

      return {
        url: location.href,
        matched: failureReason === null,
        source,
        target,
        startX: source.point ? source.point.x : null,
        startY: source.point ? source.point.y : null,
        endX: target.point ? target.point.x : null,
        endY: target.point ? target.point.y : null,
        failureReason,
        capturedAt: Date.now(),
      };
    })()`
  }
}

export { BrowserDragTargetScriptBuilder }
