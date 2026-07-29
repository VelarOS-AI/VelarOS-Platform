/**
 * composer ↔ 宿主新手引导之间的 DOM CustomEvent 名契约（pass-5 shell 収口）。
 *
 * composer 组件树（本包）与宿主 onboarding tour 之间原本经 `window` CustomEvent 双向通信：composer 打开
 * 「+」菜单 / 模型菜单时派发「opened」事件让 tour 推进；tour 需要关闭 composer 菜单时派发「close」事件让
 * composer 收起。事件**名字符串**是二者唯一契约——收敛到本包单源，宿主 `onboardingInteractionEvents`
 * 从本包再导出，避免字符串在两处漂移。
 */

/** composer「+」菜单打开——tour 监听以推进引导。 */
export const OnboardingComposerAddMenuOpenedEventName =
  'velaros:onboarding-composer-add-menu-opened'

/** composer 模型/推理菜单打开——tour 监听以推进引导。 */
export const OnboardingComposerModelMenuOpenedEventName =
  'velaros:onboarding-composer-model-menu-opened'

/** tour 请求 composer 收起所有菜单——composer（useComposerAddMenuState）监听。 */
export const OnboardingCloseComposerMenusEventName = 'velaros:onboarding-close-composer-menus'

export function dispatchOnboardingComposerAddMenuOpened(): void {
  window.dispatchEvent(new CustomEvent(OnboardingComposerAddMenuOpenedEventName))
}

export function dispatchOnboardingComposerModelMenuOpened(): void {
  window.dispatchEvent(new CustomEvent(OnboardingComposerModelMenuOpenedEventName))
}
