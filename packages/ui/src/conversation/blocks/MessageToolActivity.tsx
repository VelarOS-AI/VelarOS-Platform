import {
  memo,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CaretRightIcon, SpinnerGapIcon } from "@phosphor-icons/react";

import { StyleUtils } from "@velaros-ai/ui";
import { CopyButton } from "@velaros-ai/ui/product/buttons/CopyButton";

import { useConversationI18n, useConversationTranslatorRuntime } from "../i18n";
import { AutoScrollSuspendEventName } from "../react-hooks/scrollBehavior";
import { useDisclosurePresence } from "../react-hooks/useDisclosurePresence";
import { useTimerScope } from "../react-hooks/useTimerScope";
import { inferToolLeadingKind } from "../tool-render/inferToolLeadingKind";
import {
  isToolCallBlockLoaded,
  LazyToolCallBlock,
  preloadToolCallBlock,
} from "../tool-render/LazyToolCallBlock";
import {
  getMergedCommandCopyValue,
  getMergedToolDetails,
} from "../tool-render/messageBubbleToolModel";
import { getToolActivityGroupSummary } from "../tool-render/toolActivitySummary";
import {
  type MergedToolCallGroup,
  mergeToolCallGroups,
} from "../tool-render/toolCallRenderGrouping";
import {
  getMergedToolGroupStatusLabel,
  getToolDescription,
} from "../tool-render/toolCallSummary";

import {
  ToolResultSummaryList,
  type ToolResultSummaryTone,
} from "./ToolResultSummaryList";

import styles from "./MessageBubble.module.css";

import type { ToolCallBlock as ToolCallBlockType } from "#contracts";
import {
  isBlank,
  isFunction,
  isPresent,
  optionalWhen,
  optionalWhenLazy,
  toOptional,
} from "#internal/runtime";

const cx = StyleUtils.bindCx(styles);
const MERGED_TOOL_DETAIL_PREVIEW_LIMIT = 3;

/**
 * 归并工具行的语气按成员真实结果聚合，而非写死 success：
 * 任一成员仍在执行 → running；任一成员报错 → 全错 error / 部分错 warning；否则 success。
 * （修复：归并汇总行此前恒显 success 绿，即使成员里有失败。）
 */
function resolveMergedToolGroupTone(
  blocks: ReadonlyArray<Pick<ToolCallBlockType, "isRunning" | "error">>,
): ToolResultSummaryTone {
  if (blocks.some((block) => block.isRunning)) return "running";

  const failedCount = blocks.reduce(
    (count, block) =>
      isPresent(block.error) && !isBlank(block.error) ? count + 1 : count,
    0,
  );
  if (failedCount === 0) return "success";
  return failedCount === blocks.length ? "error" : "warning";
}
const EmptyToolActivityBlocks: ToolCallBlockType[] = [];

export function preloadToolActivityRenderer(): Promise<void> {
  return preloadToolCallBlock();
}

function isToolActivityRendererLoaded(): boolean {
  return isToolCallBlockLoaded();
}

export function shouldInitiallyExpandToolActivityDisclosure({
  autoCollapseOnMount,
  defaultExpanded,
  hasRunningTool,
}: {
  autoCollapseOnMount: boolean;
  defaultExpanded: boolean;
  hasRunningTool: boolean;
}): boolean {
  return autoCollapseOnMount || defaultExpanded || hasRunningTool;
}

export function ToolActivityDisclosure({
  blocks,
  children,
  autoCollapseOnMount = false,
  defaultExpanded = false,
  isRunning,
  label,
}: {
  blocks?: ToolCallBlockType[];
  children: ReactNode | (() => ReactNode);
  autoCollapseOnMount?: boolean;
  defaultExpanded?: boolean;
  isRunning?: boolean;
  label?: string;
}): ReactElement {
  const { t, locale } = useConversationI18n();
  const translatorRuntime = useConversationTranslatorRuntime();
  const activityBlocks = blocks ?? EmptyToolActivityBlocks;
  const hasRunningTool =
    isRunning ?? activityBlocks.some((block) => block.isRunning);
  const shouldAutoCollapseAfterMountRef = useRef(
    autoCollapseOnMount && !hasRunningTool,
  );
  const shouldAutoCollapseAfterMount = shouldAutoCollapseAfterMountRef.current;
  // 刚结束流式的「已处理」组会以新容器挂载。先继承展开态，待浏览器至少绘制一帧后再
  // 切到折叠态，CSS 才有真实的起止状态可用于播放收起动画。
  const shouldInitiallyExpand = shouldInitiallyExpandToolActivityDisclosure({
    autoCollapseOnMount: shouldAutoCollapseAfterMount,
    defaultExpanded,
    hasRunningTool,
  });
  // 与 ThinkingBlock 一致：运行态只决定初始展开；挂载后由用户点击独占 expanded，
  // 后续工具进度/运行状态更新不得把已收起的内容强行展开。
  const [expanded, setExpanded] = useState(shouldInitiallyExpand);
  const [contentRequested, setContentRequested] = useState(
    shouldInitiallyExpand,
  );
  const [contentLoadPending, setContentLoadPending] = useState(false);
  const mountedRef = useRef(true);
  const timers = useTimerScope("ToolActivityDisclosure");
  const { mounted: isMounted, visible: isVisible } =
    useDisclosurePresence(expanded);
  const lazyChildren = isFunction(children)
    ? (children as () => ReactNode)
    : null;
  const eagerChildren: ReactNode = lazyChildren
    ? null
    : (children as ReactNode);
  const contentIsLazy = isPresent(lazyChildren);
  const shouldShowContentSpinner = contentLoadPending;
  const summary = useMemo(
    () =>
      activityBlocks.length > 0
        ? getToolActivityGroupSummary(activityBlocks, locale, translatorRuntime)
        : undefined,
    [activityBlocks, locale, translatorRuntime],
  );
  const displayLabel = label || summary || t("chat.toolCalls");

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldAutoCollapseAfterMount) return;

    let collapseFrame: ReturnType<typeof timers.nextFrame> | undefined;
    const paintedExpandedFrame = timers.nextFrame(
      () => {
        collapseFrame = timers.nextFrame(
          () => {
            collapseFrame = undefined;
            setExpanded(false);
          },
          { label: "collapse processed tool activity" },
        );
      },
      { label: "paint expanded processed tool activity" },
    );

    return () => {
      paintedExpandedFrame.cancel();
      collapseFrame?.cancel();
    };
  }, [shouldAutoCollapseAfterMount, timers]);

  useEffect(() => {
    if (contentRequested && contentIsLazy) {
      void preloadToolActivityRenderer();
    }
  }, [contentIsLazy, contentRequested]);

  const requestToolActivityContent = (): void => {
    if (!contentIsLazy || contentRequested) return;

    setContentRequested(true);
    void preloadToolActivityRenderer();
  };

  const handleToggleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.currentTarget.dispatchEvent(
      new Event(AutoScrollSuspendEventName, { bubbles: true }),
    );

    if (expanded) {
      setExpanded(false);
      return;
    }

    if (!contentIsLazy) {
      setExpanded(true);
      return;
    }

    setContentRequested(true);

    if (isToolActivityRendererLoaded()) {
      setExpanded(true);
      return;
    }

    setContentLoadPending(true);
    preloadToolActivityRenderer()
      .then(() => {
        if (!mountedRef.current) return;

        setExpanded(true);
      })
      .catch(() => {
        if (!mountedRef.current) return;

        setExpanded(true);
      })
      .finally(() => {
        if (!mountedRef.current) return;

        setContentLoadPending(false);
      });
  };

  return (
    <div className={styles.toolActivityDisclosure}>
      <button
        type="button"
        className={cx(
          "toolActivityToggle",
          hasRunningTool && "toolActivityToggleRunning",
        )}
        aria-expanded={expanded}
        title={displayLabel}
        onPointerEnter={requestToolActivityContent}
        onPointerDown={requestToolActivityContent}
        onFocus={requestToolActivityContent}
        onClick={handleToggleClick}
      >
        {hasRunningTool && (
          <span className={styles.runningStatusDot} aria-hidden="true" />
        )}
        {shouldShowContentSpinner && (
          <SpinnerGapIcon
            size={12}
            className={styles.toolActivityLoadingIcon}
            aria-hidden="true"
          />
        )}
        <span className={styles.toolActivityLabel}>{displayLabel}</span>
        <CaretRightIcon
          size={14}
          weight="bold"
          className={cx(
            "toolActivityChevron",
            expanded && "toolActivityChevronExpanded",
          )}
          aria-hidden="true"
        />
      </button>
      {isMounted && (
        <div
          className={cx(
            "toolActivityBodyShell",
            expanded && isVisible && "toolActivityBodyShellExpanded",
          )}
          aria-hidden={!isVisible}
        >
          <div className={styles.toolActivityBodyFrame}>
            <div className={styles.toolActivityBody}>
              {lazyChildren
                ? optionalWhenLazy(contentRequested, lazyChildren)
                : eagerChildren}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallGroupInner({
  blocks,
  sessionId,
  planUpdateIndexByToolCallId,
  formatPathForDisplay,
}: {
  blocks: ToolCallBlockType[];
  sessionId: string;
  planUpdateIndexByToolCallId?: ReadonlyMap<string, number>;
  formatPathForDisplay?: (path: string) => string;
}): ReactElement {
  const mergedGroups = useMemo(() => mergeToolCallGroups(blocks), [blocks]);

  return (
    <div className={styles.toolGroupBody}>
      {mergedGroups.map((group) => (
        <MergedToolCallRow
          key={group.key}
          group={group}
          sessionId={sessionId}
          planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
          formatPathForDisplay={formatPathForDisplay}
        />
      ))}
    </div>
  );
}

function MergedToolCallRowInner({
  group,
  sessionId,
  planUpdateIndexByToolCallId,
  formatPathForDisplay,
}: {
  group: MergedToolCallGroup;
  sessionId: string;
  planUpdateIndexByToolCallId?: ReadonlyMap<string, number>;
  formatPathForDisplay?: (path: string) => string;
}): ReactElement {
  const { locale, t } = useConversationI18n();
  const translatorRuntime = useConversationTranslatorRuntime();
  const count = group.blocks.length;
  const details = getMergedToolDetails(
    group.blocks,
    formatPathForDisplay,
    locale,
    translatorRuntime,
  );
  let detailText = "";
  const visibleDetailCount = Math.min(
    details.length,
    MERGED_TOOL_DETAIL_PREVIEW_LIMIT,
  );
  const hasMoreDetails = details.length > visibleDetailCount;
  const detailSeparator = t("common.shortListSeparator");
  for (let index = 0; index < visibleDetailCount; index += 1) {
    const detail = details[index];
    if (!detail) continue;

    detailText = detailText
      ? `${detailText}${detailSeparator}${detail}`
      : detail;
  }
  const fallbackDetail = getToolDescription(
    group.representative,
    locale,
    formatPathForDisplay,
    translatorRuntime,
  );
  const displayName = group.toolName;
  const commandCopyValue = getMergedCommandCopyValue(group);
  const statusLabel = getMergedToolGroupStatusLabel(
    group.blocks,
    locale,
    translatorRuntime,
  );
  const detailsText = details.join(detailSeparator);
  let title = "";
  const appendTitlePart = (value: string): void => {
    if (isBlank(value)) return;

    title = title ? `${title} ${value}` : value;
  };

  if (!detailText) detailText = fallbackDetail ?? "";
  appendTitlePart(displayName);
  appendTitlePart(detailsText);
  appendTitlePart(`×${count}`);
  const planUpdateIndex = planUpdateIndexByToolCallId?.get(
    group.representative.toolCallId,
  );

  if (count <= 1)
    return (
      <div className={styles.toolGroupRow}>
        <Suspense fallback={null}>
          <LazyToolCallBlock
            block={group.representative}
            compact
            sessionId={sessionId}
            planUpdateIndex={planUpdateIndex}
            formatPathForDisplay={formatPathForDisplay}
          />
        </Suspense>
      </div>
    );

  return (
    <ToolResultSummaryList
      className={styles.toolGroupRow}
      aria-label={displayName}
      items={[
        {
          id: group.representative.toolCallId,
          kind: inferToolLeadingKind(group.toolName),
          tone: resolveMergedToolGroupTone(group.blocks),
          title,
          label: displayName,
          detail: optionalWhenLazy(detailText, () => (
            <>
              {detailText}
              {hasMoreDetails && (
                <span className={styles.mergedToolCallEllipsis}>…</span>
              )}
            </>
          )),
          detailTitle:
            details.join(detailSeparator) || fallbackDetail || undefined,
          statusLabel: statusLabel ?? `×${count}`,
          statusTitle: statusLabel ?? `×${count}`,
          actionLayout: optionalWhenLazy(commandCopyValue, () => "overlay"),
          action: optionalWhen(
            commandCopyValue,
            <CopyButton
              value={toOptional(commandCopyValue) ?? ""}
              label={t("chat.commandCopy")}
              copiedLabel={t("chat.codeBlockCopied")}
            />,
          ),
        },
      ]}
    />
  );
}

export const ToolCallGroup = memo(ToolCallGroupInner);
export const MergedToolCallRow = memo(MergedToolCallRowInner);

ToolCallGroup.displayName = "ToolCallGroup";
MergedToolCallRow.displayName = "MergedToolCallRow";
