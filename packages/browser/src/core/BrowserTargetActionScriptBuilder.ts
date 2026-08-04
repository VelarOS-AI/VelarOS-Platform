import type { BrowserTargetActionOptions } from './types'

type BrowserTargetActionClickMode = 'dom' | 'coordinate'

export interface BrowserTargetActionScriptBuildOptions {
  clickMode?: BrowserTargetActionClickMode
}

/** 构造点击/填充目标元素的页面脚本。 */
class BrowserTargetActionScriptBuilder {
  /** 根据 target 的 css/属性/文本线索定位元素并执行 click 或 fill。 */
  public buildTargetActionScript(
    options: BrowserTargetActionOptions,
    buildOptions: BrowserTargetActionScriptBuildOptions = {}
  ): string {
    const clickMode: BrowserTargetActionClickMode =
      options.action === 'click' ? buildOptions.clickMode ?? 'dom' : 'dom'
    const payload = JSON.stringify({
      action: options.action,
      clickMode,
      target: options.target,
      value: options.value ?? '',
    })
    const coordinatePointReturnScript = `return {
            action: payload.action,
            url: location.href,
            matched: true,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: toPagePoint(point),
            clickMethod: 'coordinate',
            failureReason: null,
            blockedBy: null,
            capturedAt: Date.now(),
          }`
    const clickDispatchScript =
      options.action !== 'click'
        ? ''
        : clickMode === 'coordinate'
          ? coordinatePointReturnScript
          : `element.click()`

    // target 来自 inspect/query/wait 返回的结构，脚本会按 selector -> 属性 -> 文本顺序兜底定位。
    return `(() => {
      const payload = ${payload}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
      }
      const getNodeWindow = (node) => node?.ownerDocument?.defaultView || window
      const isElementNode = (node) => !!node && node.nodeType === 1 && typeof node.tagName === 'string'
      const isNodeInstance = (node, constructorName) => {
        const view = getNodeWindow(node)
        const ctor = view?.[constructorName]
        return typeof ctor === 'function' && node instanceof ctor
      }
      const isHtmlElement = (node) => isNodeInstance(node, 'HTMLElement')
      const isHtmlIFrameElement = (node) => isNodeInstance(node, 'HTMLIFrameElement')
      const isHtmlInputElement = (node) => isNodeInstance(node, 'HTMLInputElement')
      const isHtmlLabelElement = (node) => isNodeInstance(node, 'HTMLLabelElement')
      const isHtmlSelectElement = (node) => isNodeInstance(node, 'HTMLSelectElement')
      const isHtmlTextAreaElement = (node) => isNodeInstance(node, 'HTMLTextAreaElement')
      const quoteAttr = (value) => String(value).replace(/"/g, '\\\\"')
      let targetDocument = document
      let frameElement = null
      const tryQuery = (selector) => {
        if (!selector) return null
        try {
          return targetDocument.querySelector(selector)
        } catch {
          return null
        }
      }
      const addAttributeSelector = (selectors, tagName, attr, value) => {
        if (!value) return
        selectors.push((tagName || '') + '[' + attr + '="' + quoteAttr(value) + '"]')
      }
      const tryTopDocumentQuery = (selector) => {
        if (!selector) return null
        try {
          return document.querySelector(selector)
        } catch {
          return null
        }
      }
      const readFrameDocument = (iframe) => {
        if (!isHtmlIFrameElement(iframe)) return null
        try {
          const frameDocument = iframe.contentDocument
          return frameDocument?.documentElement ? frameDocument : null
        } catch {
          return null
        }
      }
      const resolveFrameDocument = (frame) => {
        if (!frame) return { document, frameElement: null, frameRequested: false }

        const frameSelectors = []
        if (frame.css) frameSelectors.push(frame.css)
        addAttributeSelector(frameSelectors, 'iframe', 'name', frame.name)
        addAttributeSelector(frameSelectors, 'iframe', 'title', frame.title)
        addAttributeSelector(frameSelectors, 'iframe', 'aria-label', frame.title)
        addAttributeSelector(frameSelectors, 'iframe', 'src', frame.url)

        for (const selector of frameSelectors) {
          const iframe = tryTopDocumentQuery(selector)
          const frameDocument = readFrameDocument(iframe)
          if (frameDocument) return { document: frameDocument, frameElement: iframe, frameRequested: true }
        }

        const normalizedName = normalize(frame.name)
        const normalizedTitle = normalize(frame.title)
        const normalizedUrl = normalize(frame.url)
        const fallbackFrame = Array.from(document.querySelectorAll('iframe')).find((iframe) => {
          const sameName = normalizedName && normalize(iframe.getAttribute('name')) === normalizedName
          const sameTitle = normalizedTitle && normalize(iframe.getAttribute('title') || iframe.getAttribute('aria-label')) === normalizedTitle
          const sameUrl = normalizedUrl && (
            normalize(iframe.getAttribute('src')) === normalizedUrl
            || normalize(iframe.src) === normalizedUrl
          )
          return sameName || sameTitle || sameUrl
        }) || null
        const frameDocument = readFrameDocument(fallbackFrame)
        if (frameDocument) return { document: frameDocument, frameElement: fallbackFrame, frameRequested: true }

        return { document: null, frameElement: null, frameRequested: true }
      }
      const target = payload.target || {}
      const attributes = target.attributes || {}
      const frameContext = resolveFrameDocument(target.frame)
      if (frameContext.frameRequested && !frameContext.document) {
        return {
          action: payload.action,
          url: location.href,
          matched: false,
          selector: null,
          text: null,
          clickPoint: null,
          clickMethod: null,
          failureReason: 'not-found',
          blockedBy: null,
          capturedAt: Date.now(),
        }
      }
      targetDocument = frameContext.document || document
      frameElement = frameContext.frameElement
      const selectors = []
      if (target.css) selectors.push(target.css)
      if (attributes.id) selectors.push('#' + escapeCss(attributes.id))
      addAttributeSelector(selectors, '', 'data-testid', attributes['data-testid'])
      addAttributeSelector(selectors, '', 'data-test', attributes['data-test'])
      addAttributeSelector(selectors, '', 'data-qa', attributes['data-qa'])
      addAttributeSelector(selectors, '', 'name', attributes.name || target.name)
      addAttributeSelector(selectors, '', 'aria-label', attributes['aria-label'])
      addAttributeSelector(selectors, 'a', 'href', attributes.href)

      let element = null
      let matchedSelector = null
      for (const selector of selectors) {
        element = tryQuery(selector)
        if (element) {
          matchedSelector = selector
          break
        }
      }

      const inferRole = (node) => {
        const explicitRole = normalize(node.getAttribute('role'))
        if (explicitRole) return explicitRole
        const tagName = node.tagName.toLowerCase()
        if (tagName === 'a') return 'link'
        if (tagName === 'button') return 'button'
        if (tagName === 'select') return 'combobox'
        if (tagName === 'textarea') return 'textbox'
        if (tagName === 'input') {
          const type = normalize(node.getAttribute('type')).toLowerCase()
          if (type === 'submit') return 'submit'
          if (type === 'button') return 'button'
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          return 'textbox'
        }
        return null
      }
      const readAriaLabelledByText = (node) => {
        if (!isElementNode(node)) return ''
        const ownerDocument = node.ownerDocument || targetDocument || document
        return normalize(node.getAttribute('aria-labelledby'))
          .split(/\\s+/)
          .map((id) => normalize(ownerDocument.getElementById(id)?.textContent))
          .filter(Boolean)
          .join(' ')
      }
      const readFieldLabelText = (element) => {
        if (!isElementNode(element)) return ''
        const ownerDocument = element.ownerDocument || targetDocument || document
        const fieldId = element.getAttribute('id')
        const explicitLabel = fieldId
          ? normalize(ownerDocument.querySelector('label[for="' + escapeCss(fieldId) + '"]')?.textContent)
          : ''
        const wrappingLabel = normalize(element.closest('label')?.textContent)
        const labelledBy = readAriaLabelledByText(element)
        const ariaLabel = normalize(element.getAttribute('aria-label'))
        const title = normalize(element.getAttribute('title'))
        return explicitLabel || wrappingLabel || labelledBy || ariaLabel || title
      }
      const elementText = (node) => normalize(
        node.textContent
        || node.getAttribute('aria-label')
        || node.getAttribute('title')
        || node.getAttribute('placeholder')
        || node.getAttribute('value')
      )
      const describeElement = (node) => {
        if (!isElementNode(node)) return null
        const parts = [node.tagName.toLowerCase()]
        const id = normalize(node.getAttribute('id'))
        const role = normalize(node.getAttribute('role'))
        const testId = normalize(node.getAttribute('data-testid'))
        const label = normalize(
          node.getAttribute('aria-label')
          || node.getAttribute('name')
          || node.getAttribute('title')
          || node.textContent
        ).slice(0, 80)
        if (id) parts.push('#' + id)
        if (role) parts.push('[role="' + role + '"]')
        if (testId) parts.push('[data-testid="' + testId + '"]')
        if (label) parts.push(' "' + label + '"')
        return parts.join('')
      }
      const getHitTestPoint = (node) => {
        const rect = node.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return null
        const ownerDocument = node.ownerDocument || targetDocument || document
        const ownerWindow = ownerDocument.defaultView || window
        const viewportWidth = ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || 0
        const viewportHeight = ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight || 0
        const left = Math.max(rect.left, 0)
        const right = Math.min(rect.right, viewportWidth)
        const top = Math.max(rect.top, 0)
        const bottom = Math.min(rect.bottom, viewportHeight)
        if (right <= left || bottom <= top) return null
        return {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
        }
      }
      const toPagePoint = (point) => {
        if (!point || !frameElement) return point
        const frameRect = frameElement.getBoundingClientRect()
        return {
          x: point.x + frameRect.left + (frameElement.clientLeft || 0),
          y: point.y + frameRect.top + (frameElement.clientTop || 0),
        }
      }
      const isRelatedHit = (hit, targetElement) => {
        if (!isElementNode(hit)) return false
        if (hit === targetElement || targetElement.contains(hit) || hit.contains(targetElement)) return true
        const hitLabel = hit.closest('label')
        if (hitLabel && hitLabel.contains(targetElement)) return true
        const targetLabel = targetElement.closest('label')
        if (targetLabel && targetLabel.contains(hit)) return true
        const targetId = normalize(targetElement.getAttribute('id'))
        const hitFor = normalize(hit.closest('label')?.getAttribute('for'))
        if (targetId && hitFor === targetId) return true
        if (isHtmlLabelElement(hit) && hit.control === targetElement) return true
        return false
      }
      const isNativeCheckable = (node) => (
        isHtmlInputElement(node)
        && ['checkbox', 'radio'].includes(node.type.toLowerCase())
      )
      const isTextInputElement = (node) => (
        isHtmlInputElement(node)
        && ![
          'button',
          'checkbox',
          'file',
          'hidden',
          'image',
          'radio',
          'reset',
          'submit',
        ].includes(node.type.toLowerCase())
      )
      const resolveCheckableControl = (node) => {
        if (!isElementNode(node)) return null
        if (isNativeCheckable(node)) return node

        const label = isHtmlLabelElement(node) ? node : node.closest('label')
        if (label && isNativeCheckable(label.control)) return label.control

        const nested = node.querySelector('input[type="checkbox"], input[type="radio"]')
        if (isNativeCheckable(nested)) return nested

        const role = normalize(node.getAttribute('role')).toLowerCase()
        if (role === 'checkbox' || role === 'radio') return node

        return null
      }
      const readCheckableState = (control) => {
        if (isNativeCheckable(control)) return control.checked
        return normalize(control.getAttribute('aria-checked')).toLowerCase() === 'true'
      }
      const readControlState = (node) => {
        if (isHtmlSelectElement(node)) {
          return {
            kind: 'select',
            value: String(node.value ?? ''),
            selectedValues: Array.from(node.selectedOptions).map((option) => String(option.value ?? '')),
          }
        }
        if (isNativeCheckable(node)) {
          return { kind: 'checkable', checked: node.checked }
        }
        if (isTextInputElement(node) || isHtmlTextAreaElement(node)) {
          const value = String(node.value ?? '')
          if (isHtmlInputElement(node) && node.type.toLowerCase() === 'password') {
            return { kind: 'text', value: null, valueLength: value.length }
          }
          return { kind: 'text', value, valueLength: value.length }
        }
        if (isHtmlElement(node) && node.isContentEditable) {
          const value = String(node.textContent ?? '')
          return { kind: 'contenteditable', value, valueLength: value.length }
        }
        const checkable = resolveCheckableControl(node)
        return checkable
          ? { kind: 'checkable', checked: readCheckableState(checkable) }
          : null
      }
      const dispatchCheckableChange = (control) => {
        control.dispatchEvent(new Event('input', { bubbles: true }))
        control.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const applyCheckableState = (control, desiredChecked) => {
        const currentChecked = readCheckableState(control)
        if (typeof control.focus === 'function') control.focus()
        if (currentChecked === desiredChecked) return

        if (isNativeCheckable(control)) {
          control.checked = desiredChecked
          dispatchCheckableChange(control)
          return
        }

        if (typeof control.click === 'function') control.click()
        if (readCheckableState(control) !== desiredChecked) {
          control.setAttribute('aria-checked', String(desiredChecked))
          dispatchCheckableChange(control)
        }
      }
      const readSelectValues = (value) => (
        Array.isArray(value)
          ? value.map((entry) => String(entry))
          : [String(value ?? '')]
      )
      const readSelectOptions = (select) => Array.from(select.options).map((option) => ({
        value: String(option.value ?? ''),
        text: normalize(option.textContent),
        selected: option.selected,
      }))
      const optionMatchesValue = (option, value) => {
        const normalizedValue = normalize(value)
        return (
          option.value === value
          || normalize(option.value) === normalizedValue
          || normalize(option.textContent) === normalizedValue
        )
      }
      const applySelectValues = (select, value) => {
        const requestedValues = readSelectValues(value)
        const options = Array.from(select.options)
        const matchedOptions = options.filter((option) =>
          requestedValues.some((requestedValue) => optionMatchesValue(option, requestedValue))
        )
        const availableOptions = readSelectOptions(select)
        if (matchedOptions.length === 0) {
          return { matched: false, selectedValues: [], availableOptions }
        }

        select.focus()
        if (select.multiple) {
          for (const option of options) {
            option.selected = matchedOptions.includes(option)
          }
        } else {
          for (const option of options) option.selected = false
          matchedOptions[0].selected = true
        }
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))

        const selectedValues = Array.from(select.selectedOptions).map((option) => option.value)
        return { matched: true, selectedValues, availableOptions: readSelectOptions(select) }
      }
      const dispatchEditableChange = (node) => {
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const clearEditableValue = (node) => {
        if (isTextInputElement(node) || isHtmlTextAreaElement(node)) {
          node.focus()
          node.value = ''
          dispatchEditableChange(node)
          return true
        }
        if (isHtmlElement(node) && node.isContentEditable) {
          node.focus()
          node.textContent = ''
          dispatchEditableChange(node)
          return true
        }
        return false
      }
      const selectEditableContents = (node) => {
        if (isTextInputElement(node) || isHtmlTextAreaElement(node)) {
          node.focus()
          node.select()
          return true
        }
        if (!isElementNode(node)) return false

        node.scrollIntoView({ block: 'center', inline: 'center' })
        if (isHtmlElement(node) && typeof node.focus === 'function') node.focus()
        const ownerDocument = node.ownerDocument || targetDocument || document
        const ownerWindow = ownerDocument.defaultView || window
        const range = ownerDocument.createRange()
        range.selectNodeContents(node)
        const selection = ownerWindow.getSelection()
        if (!selection) return false
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      }

      if (!element) {
        const targetRole = normalize(target.role)
        const targetText = normalize(target.text)
        const targetName = normalize(target.name || attributes.name)
        const candidates = Array.from(targetDocument.querySelectorAll(
          [
            'button',
            'input',
            'textarea',
            'select',
            'a[href]',
            '[contenteditable="true"]',
            '[contenteditable=""]',
            '[role="button"]',
            '[role="link"]',
            '[role="textbox"]',
            '[role="menuitem"]',
            '[role="menuitemcheckbox"]',
            '[role="menuitemradio"]',
            '[role="option"]',
            '[role="tab"]',
            '[role="switch"]',
            '[role="checkbox"]',
            '[role="radio"]',
          ].join(',')
        ))
        element = candidates.find((node) => {
          const role = inferRole(node)
          const roleMatches =
            !targetRole
            || role === targetRole
            || (targetRole === 'textbox' && role === 'textbox')
            || (targetRole === 'button' && role === 'submit')
            || (targetRole === 'checkbox' && role === 'switch')
          if (!roleMatches) return false
          if (targetName && normalize(node.getAttribute('name')) === targetName) return true
          if (!targetText) return false
          const text = elementText(node) || readFieldLabelText(node)
          return text === targetText || text.includes(targetText)
        }) || null
      }

      if (!element) {
        return {
          action: payload.action,
          url: location.href,
          matched: false,
          selector: matchedSelector,
          text: null,
          clickPoint: null,
          clickMethod: null,
          failureReason: 'not-found',
          blockedBy: null,
          capturedAt: Date.now(),
        }
      }

      const visibleText = elementText(element) || readFieldLabelText(element)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      let selectedValues = null

      if (payload.action === 'select') {
        if (!isHtmlSelectElement(element)) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }

        const selectResult = applySelectValues(element, payload.value)
        if (!selectResult.matched) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            selectedValues: selectResult.selectedValues,
            availableOptions: selectResult.availableOptions,
            failureReason: 'option-not-found',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
        selectedValues = selectResult.selectedValues
      } else if (payload.action === 'fill') {
        const value = String(payload.value || '')
        if (isHtmlInputElement(element) && ['checkbox', 'radio'].includes(element.type.toLowerCase())) {
          const normalizedValue = value.trim().toLowerCase()
          element.focus()
          element.checked = ['true', '1', 'yes', 'y', 'on', 'checked'].includes(normalizedValue)
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (isHtmlSelectElement(element)) {
          element.focus()
          const normalizedValue = normalize(value)
          const optionByTextOrValue = Array.from(element.options).find((option) =>
            option.value === value
            || normalize(option.value) === normalizedValue
            || normalize(option.textContent) === normalizedValue
          )
          if (!optionByTextOrValue) {
            return {
              action: payload.action,
              url: location.href,
              matched: false,
              selector: matchedSelector || target.css || null,
              text: visibleText || null,
              clickPoint: null,
              clickMethod: null,
              failureReason: 'option-not-found',
              blockedBy: null,
              capturedAt: Date.now(),
            }
          }
          element.value = optionByTextOrValue.value
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (isHtmlInputElement(element) || isHtmlTextAreaElement(element)) {
          element.focus()
          element.value = value
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (isHtmlElement(element) && element.isContentEditable) {
          element.focus()
          element.textContent = value
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        } else {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
      } else if (payload.action === 'scroll_into_view') {
        // 上方通用 scrollIntoView 已完成动作，这里避免继续走点击分支。
      } else if (payload.action === 'focus') {
        element.focus()
      } else if (payload.action === 'clear') {
        if (!clearEditableValue(element)) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
      } else if (payload.action === 'select_all') {
        if (!selectEditableContents(element)) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
      } else if (payload.action === 'check' || payload.action === 'uncheck') {
        const control = resolveCheckableControl(element)
        if (!control) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
        const desiredChecked = payload.action === 'check'
        applyCheckableState(control, desiredChecked)
      } else {
        const point = getHitTestPoint(element)
        if (!point) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'not-interactable',
            blockedBy: null,
            capturedAt: Date.now(),
          }
        }
        const hitDocument = element.ownerDocument || targetDocument || document
        const hit = hitDocument.elementFromPoint(point.x, point.y)
        if (!isRelatedHit(hit, element)) {
          return {
            action: payload.action,
            url: location.href,
            matched: false,
            selector: matchedSelector || target.css || null,
            text: visibleText || null,
            clickPoint: null,
            clickMethod: null,
            failureReason: 'covered',
            blockedBy: describeElement(hit),
            capturedAt: Date.now(),
          }
        }
        if (payload.action === 'hover') {
          ${coordinatePointReturnScript}
        }
        ${clickDispatchScript}
      }

      return {
        action: payload.action,
        url: location.href,
        matched: true,
        selector: matchedSelector || target.css || null,
        text: visibleText || null,
        clickPoint: null,
        clickMethod: payload.action === 'click' ? 'dom' : null,
        selectedValues,
        controlState: readControlState(element),
        failureReason: null,
        blockedBy: null,
        capturedAt: Date.now(),
      }
    })()`
  }
}

export { BrowserTargetActionScriptBuilder }
