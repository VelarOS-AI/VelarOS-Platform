import { isEmpty, truncate } from "@velaros-ai/core";

import { PromptSegmentPriority } from '../../contract/constants.js'
import type { PromptSegmentDefinition, RuntimePromptSnapshot, RuntimePromptToolCategorySummary } from '../../types/guidance.js'
import { AgentTuning } from '../tuning'

import { createCorePromptSegment, createSelectedSkillPromptSegment, createSkillPromptSegment, createTextPromptSegment, formatLabelList, hasAnyRuntimeTool, hasAnyRuntimeToolAvailable, hasRuntimeTool } from "./shared";
import { createTaskRuntimePromptSegments } from "./task";

/** 提示词里最多列几个自定义子 Agent，值在 `AgentTuning.prompt.maxCustomSubAgentEntries`。 */
const MaxCustomSubAgentPromptEntries = AgentTuning.prompt.maxCustomSubAgentEntries;

/**
 * 渲染"自定义子 Agent 有哪些"那一行（id、base、说明），最多列 `MaxCustomSubAgentPromptEntries` 个，
 * 多出来的不逐条列、只在末尾补一句「另有 N 个未列出」——截断这件事必须让模型知道，否则它会以为清单就这么多。
 * 一个都没有时返回空数组，整行不出现。这是没有派发目录时的**回落**渲染。
 */
function renderCustomSubAgentLines(snapshot: RuntimePromptSnapshot): string[] {
  const agents = snapshot.customSubAgents.slice(
    0,
    MaxCustomSubAgentPromptEntries,
  );
  if (isEmpty(agents)) return [];
  const omitted = snapshot.customSubAgents.length - agents.length;
  return [
    `- 自定义子 Agent：${agents
      .map(
        (agent) => `${agent.id}（base: ${agent.base}）：${agent.description}`,
      )
      .join("；")}${omitted > 0 ? `；另有 ${omitted} 个未列出` : ""}。`,
  ];
}

/**
 * 渲染本轮可派的 `subagent_type` 目录：每种工种一行，标出它是"默认只读"还是"按授权工具执行"，
 * 说明压平空白后截到 160 字（工种说明是给人看的，进提示词只需要够辨认，不需要全文）。
 * 快照没带目录时回落到 {@link renderCustomSubAgentLines}。
 * 末尾那句"用途说明不授予额外能力"是有意加的：模型很容易把一段描述当成授权，而实际能力只由子 Agent 的工具范围决定。
 */
function renderSubAgentDispatchCatalog(snapshot: RuntimePromptSnapshot): string[] {
  const catalog = snapshot.subAgentDispatchCatalog;
  if (!catalog) return renderCustomSubAgentLines(snapshot);
  return [
    `本轮可用 subagent_type（新建省略时使用 ${JSON.stringify(catalog.defaultTypeId)}；续跑省略则继承原线程）：`,
    ...catalog.types.map((type) =>
      `${JSON.stringify(type.id)}：${type.readonlyDefault ? "默认只读" : "按授权工具执行"}${type.description ? `；${truncate(type.description.replace(/\s+/gu, " ").trim(), 160)}` : ""}`,
    ),
    "用途说明不授予额外能力；按子 Agent 实际工具范围派工，复核任务使用 readonly=true。",
  ];
}

/**
 * 拼「工具执行链」那一段的正文：先是六条与具体工具无关的通用纪律（以本轮 schema 为准、先读真值再写、
 * 有数据依赖的调用必须分轮、遇截断按 continuation 补齐、失败重试只补要改的字段、上下文会被自动整理），
 * 按当前可调用工具补充发现与使用指引。
 * 按需追加是关键：讲一个这轮根本调不到的工具，只会诱导模型去调一个不存在的名字。
 */
function buildRuntimeToolCapabilityMap(
  snapshot: RuntimePromptSnapshot,
): string {
  const lines = [
    "工具名、参数、前置条件和返回值以本轮 schema/description 为准。",
    "输出依赖文件、页面或外部状态时，先读取当前真值；复杂任务按发现、有限读取、执行、验证推进。",
    "存在数据依赖的工具调用必须分轮：先等待读取或运行结果，再据真实返回写入或提交；只并行互不依赖的调用。",
    "遇到截断或低置信结果时，按回执提供的 continuation、cursor 或 nextOffset 补齐当前任务所需证据。",
    "失败回执提供参数复用入口时，只补需要更正的字段；历史省略标注不能当作源码或完整参数重放。",
    "上下文材料受当前请求预算约束；缺口按实际回执处理。",
  ];
  if (hasRuntimeTool(snapshot, "tooling:map")) {
    lines.push(
      "缺少能力时先用 tooling:map 查看可装载能力，再按返回的 activation 信息处理。",
    );
  }
  return lines.join("\n");
}

/**
 * 按当前运行快照产出这一轮的全部 Tier1 运行态提示词段（语言纪律、任务段、能力方贡献段、子 Agent 派发、工具执行链、已选能力）。
 *
 * 各段的相对位置由 `priority` 上的偏移量钉死，不靠数组顺序——组装器会重排，写在这里的先后只是可读性。
 * 带 `when` 的段是"这一轮不满足条件就整段不渲染"，组装器会留一条带 reason 的痕，便于在调试面板区分"被拦下"与"压根没有这段"。
 * **`contextPhase === 'bootstrap'` 会提前返回**：快启阶段只补一段"先取最小事实"的建议，
 * 刻意不铺工具执行链与已选能力——新任务开头模型还没有可执行的上下文，这时灌满纪律只是白占预算、还会拖慢第一次响应。
 */
function createRuntimePromptSegments(
  snapshot: RuntimePromptSnapshot,
  capabilitySegments: readonly PromptSegmentDefinition[] = [],
): PromptSegmentDefinition[] {
  const fallbackLanguage = snapshot.locale === "zh-CN" ? "简体中文" : "English";
  const segments: PromptSegmentDefinition[] = [
    createTextPromptSegment({
      id: "runtime.session",
      label: "本次会话的运行态",
      source: "runtime",
      priority: PromptSegmentPriority.runtime,
      text: `回复跟随用户当前使用的语言；无法判断时使用${fallbackLanguage}。代码、命令、路径和专有名词保留必要原文。`,
    }),
    ...createTaskRuntimePromptSegments(snapshot),
    ...capabilitySegments,
  ];

  segments.push(
    createTextPromptSegment({
      id: "runtime.sub-agent-dispatch",
      label: "子 Agent 派发",
      source: "runtime",
      priority: PromptSegmentPriority.runtime + 31.5,
      when: () => hasAnyRuntimeTool(snapshot, ["agent:dispatch", "agent:run_workflow"]),
      text: [
        "把可独立并行或本身需要多步的有界子任务交给子 Agent；主 Agent 直接完成其余工作。",
        "优先复用已派的子 Agent：同一工作线上的追问、补做、纠偏、修复后的复验，用 thread_id 续跑它（它保留着读过的上下文，不必从头再读），复验就续跑原来的验证者。",
        "只有需要独立上下文时才新派：独立复核或第二意见（不要让产出者复核自己的产出）、原线程已跑偏或上下文过大、换了作用域或是无关的新任务。线程只保留有限时间，过期续跑会明确报错，再新派一个自包含的。",
        "主 Agent 统一负责综合、验证和收口。",
        ...renderSubAgentDispatchCatalog(snapshot),
      ].join("\n"),
    }),
  );

  if (snapshot.contextPhase === "bootstrap") {
    segments.push(
      createTextPromptSegment({
        id: "runtime.bootstrap-context",
        label: "快速起步上下文",
        source: "runtime",
        priority: PromptSegmentPriority.runtimeAdvice - 30,
        text: [
          "这是新任务的快速启动阶段。简单问答直接回答；执行任务先取得完成当前下一步所需的最小事实。",
        ].join("\n"),
      }),
    );
    return segments;
  }

  segments.push(
    createTextPromptSegment({
      id: "runtime.tool-capability-map",
      label: "工具执行链",
      source: "runtime",
      priority: PromptSegmentPriority.runtime + 31,
      when: () => hasAnyRuntimeToolAvailable(snapshot),
      text: buildRuntimeToolCapabilityMap(snapshot),
    }),
    createTextPromptSegment({
      id: "runtime.selected-capability-hints",
      label: "本轮已选能力",
      source: "runtime",
      priority: PromptSegmentPriority.runtime + 33,
      when: () => !isEmpty(snapshot.selectedPromptFeatureLabels),
      text: `本轮已选能力：${formatLabelList(snapshot.selectedPromptFeatureLabels)}`,
    }),
  );
  return segments;
}

export {
  createCorePromptSegment,
  createRuntimePromptSegments,
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
  createTextPromptSegment,
  PromptSegmentPriority,
};
export type { RuntimePromptSnapshot, RuntimePromptToolCategorySummary };
