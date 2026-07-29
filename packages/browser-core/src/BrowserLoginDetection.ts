/**
 * 登录墙检测启发式的共享脚本片段(全仓单源)。
 *
 * URL 路径 / 标题文案 / 密码框 / 登录表单 / 登录按钮 / 验证码·会话过期文案累加置信度,
 * 定义 `detectLogin()`(以及它依赖的 `normalizeText` / `visible` / 若干 pattern)。返回值形状
 * 与 `BrowserLoginDetection` (owned by `@velaros-ai/browser-core`)一致。
 *
 * 两处消费,同一份定义:
 *  - `buildBrowserLoginDetectionScript()`(下方)把它包成独立 IIFE,供 BrowserToolResultEnhancer
 *    在 inspect_page / navigate_page 等**不截图**的观察路径上按需 `evaluateScript` 跑一遍。
 *  - `@velaros-ai/browser-runtime` 的 BrowserScreenshotEngine 截图元数据脚本把它内嵌进更大的
 *    metadata IIFE,截图时顺带产出 login 字段。
 *
 * ⚠️ 改动检测启发式只改这一份;两个消费点自动同步。
 */
export const browserLoginDetectionScriptFragment = `
  const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03;
  };
  const loginTextPattern = /\\b(log\\s*in|sign\\s*in|signin|sign-in|continue\\s+with|authenticate|authentication|two[-\\s]?factor|2fa|sso)\\b|登录|登入|登陆|请登录|账号登录|密码|验证码|扫码登录|人机验证/i;
  const passkeyPattern = /\\b(passkey|security\\s+key|complete\\s+sign-in\\s+using|verifying\\s+it(?:'|’)s\\s+you)\\b|通行密钥|安全密钥|验证(?:你|您)的身份/i;
  const humanChallengePattern = /\\b(verify\\s+you\\s+are\\s+human|checking\\s+your\\s+browser|complete\\s+the\\s+security\\s+check)\\b|验证(?:你|您)是人类|请完成.{0,12}人机验证/i;
  const usernamePattern = /\\b(email|e-mail|username|user|account|login|phone|mobile)\\b|邮箱|账号|账户|手机号|用户名/i;
  const detectLogin = () => {
    const path = String(location.pathname || '');
    const title = normalizeText(document.title);
    const bodyText = normalizeText((document.body && document.body.innerText) || '');
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]')).filter(visible);
    const usernameInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter((element) => {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      if (['password', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return false;
      const haystack = [
        element.getAttribute('name'),
        element.getAttribute('id'),
        element.getAttribute('autocomplete'),
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label')
      ].map(normalizeText).join(' ');
      return visible(element) && usernamePattern.test(haystack);
    });
    const actions = Array.from(document.querySelectorAll('button, input[type="submit"], a[href], [role="button"], [role="link"]')).filter(visible);
    const loginButtons = actions.filter((element) => loginTextPattern.test(normalizeText(element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title'))));
    const loginLinks = Array.from(document.querySelectorAll('a[href]')).filter((element) => {
      const text = normalizeText(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title'));
      const href = String(element.getAttribute('href') || '');
      return visible(element) && (loginTextPattern.test(text) || /login|signin|sign-in|auth/i.test(href));
    });
    const forms = Array.from(document.querySelectorAll('form')).filter((form) => {
      const text = normalizeText(form.innerText);
      return visible(form) && (form.querySelector('input[type="password"]') || loginTextPattern.test(text));
    });
    const signals = [];
    if (/\\/((log|sign)[_-]?in|login|signin|auth|oauth|session|account)\\b/i.test(path)) signals.push('url-login-path');
    if (loginTextPattern.test(title)) signals.push('title-login-text');
    if (passwordInputs.length > 0) signals.push('password-input');
    if (usernameInputs.length > 0) signals.push('username-input');
    if (loginButtons.length > 0) signals.push('login-action');
    if (forms.length > 0) signals.push('login-form');
    if (/验证码|扫码|two[-\\s]?factor|2fa|captcha|人机验证/i.test(bodyText)) signals.push('verification-text');
    if (passkeyPattern.test(bodyText)) signals.push('passkey-text');
    if (humanChallengePattern.test(bodyText)) signals.push('human-challenge-text');
    if (/unauthorized|forbidden|401|403|session expired|会话已过期|未授权|无权限/i.test(bodyText)) signals.push('auth-error-text');

    let confidence = 0;
    if (signals.includes('password-input')) confidence += 0.46;
    if (signals.includes('username-input')) confidence += 0.16;
    if (signals.includes('login-action')) confidence += 0.16;
    if (signals.includes('login-form')) confidence += 0.18;
    if (signals.includes('url-login-path')) confidence += 0.22;
    if (signals.includes('title-login-text')) confidence += 0.16;
    if (signals.includes('verification-text')) confidence += 0.12;
    if (signals.includes('passkey-text')) confidence += 0.44;
    if (signals.includes('human-challenge-text')) confidence += 0.66;
    if (signals.includes('auth-error-text')) confidence += 0.18;
    confidence = Math.min(1, confidence);
    const requiresLogin =
      confidence >= 0.62 &&
      (
        passwordInputs.length > 0 ||
        forms.length > 0 ||
        signals.includes('passkey-text') ||
        signals.includes('human-challenge-text') ||
        signals.includes('auth-error-text') ||
        (signals.includes('url-login-path') && (loginButtons.length > 0 || usernameInputs.length > 0))
      );

    return {
      requiresLogin,
      confidence,
      reason: requiresLogin
        ? '页面看起来停在登录、身份验证或会话过期状态，需要用户手动完成。'
        : '未检测到明确登录墙。',
      signals,
      passwordInputs: passwordInputs.length,
      usernameInputs: usernameInputs.length,
      loginButtons: loginButtons.length,
      loginLinks: loginLinks.length,
      forms: forms.length,
    };
  };
`

/**
 * 登录墙检测脚本(独立版):把共享启发式片段包成独立 IIFE,直接 `evaluateScript` 得到检测结果。
 */
export function buildBrowserLoginDetectionScript(): string {
  return `(() => {${browserLoginDetectionScriptFragment}
  return detectLogin();
})()`
}
