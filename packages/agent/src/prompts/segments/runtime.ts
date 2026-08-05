import { isEmpty } from "@velaros-ai/core";

import type { PromptSegmentDefinition } from "../registry";

import {
  createCorePromptSegment,
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
  createTextPromptSegment,
  formatLabelList,
  hasAnyRuntimeTool,
  hasAnyRuntimeToolAvailable,
  hasRuntimeTool,
  PromptSegmentPriority,
  type RuntimePromptSnapshot,
  type RuntimePromptToolCategorySummary,
} from "./shared";
import { createTaskRuntimePromptSegments } from "./task";

const MaxCustomSubAgentPromptEntries = 12;

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

function buildRuntimeToolCapabilityMap(
  snapshot: RuntimePromptSnapshot,
): string {
  const lines = [
    "工具名、参数、前置条件和返回值以本轮 schema/description 为准。",
    "输出依赖文件、页面或外部状态时，先读取当前真值；复杂任务按发现、有限读取、执行、验证推进。",
    "存在数据依赖的工具调用必须分轮：先等待读取或运行结果，再据真实返回写入或提交；只并行互不依赖的调用。",
    "遇到 truncated、has_more、next_cursor 或低置信结果时继续补齐所需证据。",
  ];
  if (hasRuntimeTool(snapshot, "tooling:map")) {
    lines.push(
      "缺少能力时先用 tooling:map 查看可装载能力，再按返回的 activation 信息处理。",
    );
  }
  if (hasAnyRuntimeTool(snapshot, ["context:recall"])) {
    lines.push("需要恢复已裁剪证据时调用 context:recall。");
  }
  if (hasAnyRuntimeTool(snapshot, ["context:distill"])) {
    lines.push("长任务阶段转折点可调用 context:distill 保存关键事实和进度。");
  }
  return lines.join("\n");
}

function createRuntimePromptSegments(
  snapshot: RuntimePromptSnapshot,
  capabilitySegments: readonly PromptSegmentDefinition[] = [],
): PromptSegmentDefinition[] {
  const fallbackLanguage = snapshot.locale === "zh-CN" ? "简体中文" : "English";
  const segments: PromptSegmentDefinition[] = [
    createTextPromptSegment({
      id: "runtime.session",
      label: "Session Runtime",
      source: "runtime",
      priority: PromptSegmentPriority.runtime,
      text: `回复跟随用户当前使用的语言；无法判断时使用${fallbackLanguage}。代码、命令、路径和专有名词保留必要原文。`,
    }),
    ...createTaskRuntimePromptSegments(snapshot),
    ...capabilitySegments,
  ];

  if (snapshot.contextPhase === "bootstrap") {
    segments.push(
      createTextPromptSegment({
        id: "runtime.bootstrap-context",
        label: "Fast Start Context",
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
      label: "Agent Tool Execution Chain",
      source: "runtime",
      priority: PromptSegmentPriority.runtime + 31,
      when: () => hasAnyRuntimeToolAvailable(snapshot),
      text: buildRuntimeToolCapabilityMap(snapshot),
    }),
    createTextPromptSegment({
      id: "runtime.sub-agent-dispatch",
      label: "Sub-Agent Dispatch",
      source: "runtime",
      priority: PromptSegmentPriority.runtime + 31.5,
      when: () => hasRuntimeTool(snapshot, "agent:dispatch"),
      text: [
        "子 Agent 只用于可独立并行或本身需要多步的有界子任务；能直接完成的工作不要外派。",
        "主 Agent 负责综合、验证和收口。",
        ...renderCustomSubAgentLines(snapshot),
      ].join("\n"),
    }),
    createTextPromptSegment({
      id: "runtime.selected-capability-hints",
      label: "Selected Capabilities",
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
