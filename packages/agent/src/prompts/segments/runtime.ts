import { isEmpty, truncate } from "@velaros-ai/core";

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

function buildRuntimeToolCapabilityMap(
  snapshot: RuntimePromptSnapshot,
): string {
  const lines = [
    "工具名、参数、前置条件和返回值以本轮 schema/description 为准。",
    "输出依赖文件、页面或外部状态时，先读取当前真值；复杂任务按发现、有限读取、执行、验证推进。",
    "存在数据依赖的工具调用必须分轮：先等待读取或运行结果，再据真实返回写入或提交；只并行互不依赖的调用。",
    "遇到截断或低置信结果时，按回执提供的 continuation、cursor 或 nextOffset 补齐当前任务所需证据。",
    "失败回执提供参数复用入口时，只补需要更正的字段；历史省略标注不能当作源码或完整参数重放。",
    "系统在完整请求超出模型可用容量时自动整理上下文。",
  ];
  if (hasRuntimeTool(snapshot, "tooling:map")) {
    lines.push(
      "缺少能力时先用 tooling:map 查看可装载能力，再按返回的 activation 信息处理。",
    );
  }
  if (hasAnyRuntimeTool(snapshot, ["context:recall"])) {
    lines.push("需要恢复已裁剪证据时调用 context:recall。");
  }
  if (hasAnyRuntimeTool(snapshot, ["context:handoff"])) {
    lines.push(
      "系统自动整理后当前会话仍无法继续时，调用 context:handoff 请求用户批准交接。",
    );
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

  segments.push(
    createTextPromptSegment({
      id: "runtime.sub-agent-dispatch",
      label: "Sub-Agent Dispatch",
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
