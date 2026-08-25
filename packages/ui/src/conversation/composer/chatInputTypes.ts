import type { IconWeight } from "@phosphor-icons/react";
import type React from "react";

import type { ChatVirtualPasteReference } from "./utils/chatVirtualPasteReferences";

import type { ChatPromptFeatureId, RunProfileSelectionId } from "#contracts";
import type { ReasoningLevel } from "#contracts";
import type { PromptFeatureLabelKey } from "#internal/promptFeatures";

export interface ChatInputSendDraft {
  value?: string;
  files?: File[];
  virtualPasteReferences?: ChatVirtualPasteReference[];
}

export interface ChatInputRunProfileControl {
  value: RunProfileSelectionId;
  disabled?: boolean;
  onChange: (value: RunProfileSelectionId) => void;
}

/** 思考力度控制；聊天 Composer 配有独立展示开关时只暴露 low/medium/high/ultra。 */
export interface ChatInputThinkingDepthControl {
  value: ReasoningLevel;
  disabled?: boolean;
  onChange: (value: ReasoningLevel) => void;
}

/** 仅控制思考块是否渲染，不参与请求参数或模型推理力度。 */
export interface ChatInputThinkingVisibilityControl {
  value: boolean;
  disabled?: boolean;
  onChange: (visible: boolean) => void;
}

export interface ChatInputPureChatControl {
  value: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}

export interface ChatInputSelectionRange {
  start: number;
  end: number;
}

// ─── Composer submenu ────────────────────────────────────────────────────────

export type ComposerSubmenuId = "quick-prompts" | "plugins" | "skills";

// ─── Prompt feature label keys ───────────────────────────────────────────────

export type ChatInputPromptFeatureLabelKey = PromptFeatureLabelKey;

// ─── 图标组件类型 ─────────────────────────────────────────────────────────────
// 通用组件类型不包含转发引用组件，因此这里定义成普通可调用接口，
// 让常规组件和转发引用图标都能按结构赋值。
export interface ChatInputIconComponent {
  (props: { size?: number | string; weight?: IconWeight }): React.ReactNode;
}

// ─── Prompt feature option shapes ────────────────────────────────────────────

export interface ChatInputPromptFeatureOption {
  id: ChatPromptFeatureId;
  labelKey: ChatInputPromptFeatureLabelKey;
  icon: ChatInputIconComponent;
}

export interface ChatInputPromptFeatureGroupOption {
  id: string;
  featureIds: ChatPromptFeatureId[];
  labelKey: ChatInputPromptFeatureLabelKey;
  icon: ChatInputIconComponent;
}

export interface ChatInputQueuedDraft {
  id: string;
  value: string;
  files: File[];
  virtualPasteReferences?: ChatVirtualPasteReference[];
}

export interface ChatInputSkillOption {
  id: string;
  label: string;
  description?: string;
  builtIn?: boolean;
}

export type ChatInputSkillDetailHandler = (
  skill: ChatInputSkillOption,
) => void | Promise<void>;

/** 聊天输入 `@` 菜单里的一条**可引用项**。 */
export interface ChatInputMentionableOption {
  id: string;
  /** 展示定位，如 `src/foo.ts:12-20`，或被选中实体的名字。 */
  label: string;
  /** 正文（列表描述 + 发送上下文用）。 */
  body: string;
}

/**
 * **可引用项**接入 composer 的网关。
 *
 * 来源无关：工作台行内评论、空间选中对象、任何声明「我的 delta 走 mention 面不走 chip 面」
 * 的 mod，都只是它的一种来源。`@` 菜单列出 `available`，可移除/多选；选中项以 chip 显示，
 * 发送后由上层消费。
 *
 * `header` / `deleteLabel` **由来源注入**：菜单不替任何来源起名字。上一版把这条通道写死叫「评论」，
 * 但其他来源可能提供选中对象；来源文案必须由调用方提供，不能让面板错误显示成「评论」。
 */
export interface ChatInputMentionables {
  available: ChatInputMentionableOption[];
  selectedIds: string[];
  /** 菜单表头文案（如「评论」「选中实体」）；缺席时回落通用文案。 */
  header?: string;
  /** 列表项移除按钮文案；缺席时回落通用文案。 */
  deleteLabel?: string;
  onToggleSelected: (id: string, selected: boolean) => void;
  onDelete: (id: string) => void;
}

export interface ChatInputManualTestPromptOption {
  id: string;
  title: string;
  description?: string;
  prompt: string;
}

// ─── Browser Web Speech API ────────────────────────────────────────────────
// TypeScript stdlib 未内置 Web Speech API 的完整类型，这里手动声明浏览器实现用到的最小接口集。

export interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
}

export interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative | undefined;
}

export interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionResult | undefined;
}

export interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

export interface BrowserSpeechRecognitionErrorEvent {
  readonly error?: string;
  readonly message?: string;
}

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: Nullable<(event: BrowserSpeechRecognitionEvent) => void>;
  onerror: Nullable<(event: BrowserSpeechRecognitionErrorEvent) => void>;
  onend: Nullable<() => void>;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type BrowserSpeechRecognitionConstructor =
  new () => BrowserSpeechRecognition;

export type { ChatVirtualPasteReference };

/**
 * 模型选择下拉的单条选项（value/label + 可选简短元数据）。pass-5 composer 入包后由本包自持，
 * 宿主 `modelOptions.utils`（依赖 localStorage 校验，留宿主）构造后经 `ChatComposerControl` 传入。
 */
export interface ModelSelectOption {
  value: string;
  label: string;
  description?: string;
  /** Long-form model details shown from a right-side question icon. */
  help?: string;
  /** 面向选择列表的简短元数据，例如上下文容量；不要放长说明。 */
  meta?: string;
  disabled?: boolean;
}
