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
import { useConversationScrollFollow } from "../react-hooks/conversationScrollFollow";
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

import { ToolActivityMotion } from "./ToolActivityMotion";
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
  autoCollapseAfterPaint,
  defaultExpanded,
  hasRunningTool,
}: {
  autoCollapseAfterPaint: boolean;
  defaultExpanded: boolean;
  hasRunningTool: boolean;
}): boolean {
  return autoCollapseAfterPaint || defaultExpanded || hasRunningTool;
}

export function ToolActivityDisclosure({
  blocks,
  children,
  autoCollapseAfterPaint = false,
  defaultExpanded = false,
  isRunning,
  label,
}: {
  blocks?: ToolCallBlockType[];
  children: ReactNode | (() => ReactNode);
  autoCollapseAfterPaint?: boolean;
  defaultExpanded?: boolean;
  isRunning?: boolean;
  label?: string;
}): ReactElement {
  const { t, locale } = useConversationI18n();
  const translatorRuntime = useConversationTranslatorRuntime();
  const activityBlocks = blocks ?? EmptyToolActivityBlocks;
  const hasRunningTool =
    isRunning ?? activityBlocks.some((block) => block.isRunning);
  const shouldAutoCollapseAfterPaint =
    autoCollapseAfterPaint && !hasRunningTool;
  // 完成信号可能在容器已经挂载后到达。信号保持实时，先呈现展开态，再在浏览器绘制后
  // 切到折叠态，使原地完成和新容器挂载都能执行同一条自动收起路径。
  const shouldInitiallyExpand = shouldInitiallyExpandToolActivityDisclosure({
    autoCollapseAfterPaint: shouldAutoCollapseAfterPaint,
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
  const scrollFollow = useConversationScrollFollow();
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
    if (!shouldAutoCollapseAfterPaint) return;

    let collapseFrame: ReturnType<typeof timers.nextFrame> | undefined;
    const paintedExpandedFrame = timers.nextFrame(
      () => {
        collapseFrame = timers.nextFrame(
          () => {
            collapseFrame = undefined;
            // 读者已上滑解除跟随：他可能正读着这组内容，收起会把视口里的节点整段抽走。
            // 保持展开，收不收由他自己点。
            if (!scrollFollow.isFollowingBottom()) return;
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
  }, [scrollFollow, shouldAutoCollapseAfterPaint, timers]);

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
  animateLiveToolActivity,
  messageId,
  sessionId,
  planUpdateIndexByToolCallId,
  formatPathForDisplay,
}: {
  blocks: ToolCallBlockType[];
  animateLiveToolActivity: boolean;
  messageId: string;
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
          animateLiveToolActivity={animateLiveToolActivity}
          messageId={messageId}
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
  animateLiveToolActivity,
  messageId,
  sessionId,
  planUpdateIndexByToolCallId,
  formatPathForDisplay,
}: {
  group: MergedToolCallGroup;
  animateLiveToolActivity: boolean;
  messageId: string;
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

  const content =
    count <= 1 ? (
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
    ) : (
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

  return (
    <ToolActivityMotion
      activityKey={`tool:${group.blocks[0]?.toolCallId ?? group.representative.toolCallId}`}
      blocks={group.blocks}
      isStreaming={animateLiveToolActivity}
      messageId={messageId}
      sessionId={sessionId}
    >
      {content}
    </ToolActivityMotion>
  );
}

export const ToolCallGroup = memo(ToolCallGroupInner);
export const MergedToolCallRow = memo(MergedToolCallRowInner);

ToolCallGroup.displayName = "ToolCallGroup";
MergedToolCallRow.displayName = "MergedToolCallRow";
