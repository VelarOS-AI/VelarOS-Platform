export type { BrowserCdpNetworkControllerDeps } from '../impl/cdp/BrowserCdpNetworkController'
export { BrowserCdpNetworkController } from '../impl/cdp/BrowserCdpNetworkController'
export type { BrowserCommandSpec } from '../impl/cdp/BrowserPlatformCompatibility'
export { BrowserPlatformCompatibility } from '../impl/cdp/BrowserPlatformCompatibility'
export type {
  CdpBrowserPageDriverConnectOptions,
  CdpBrowserPageDriverOptions,
  CdpBrowserPageDriverTransport,
} from '../impl/cdp/CdpBrowserPageDriver'
export { CdpBrowserPageDriver } from '../impl/cdp/CdpBrowserPageDriver'
export type { CdpExternalBrowserLauncherDependencies, CdpExternalBrowserLaunchOptions, CdpExternalBrowserSession } from '../impl/cdp/CdpExternalBrowserLauncher'
export { CdpExternalBrowserLauncher } from '../impl/cdp/CdpExternalBrowserLauncher'
export type {
  CdpScreencastConsumerOptions,
  CdpScreencastStartOptions,
  EncodeScreencastGifOptions,
  ScreencastCapturedFrame,
  ScreencastFrameDecoder,
} from '../impl/cdp/CdpScreencastRecorder'
export {
  CdpScreencastRecorder,
  DefaultScreencastStartOptions,
  encodeScreencastFramesToGif,
} from '../impl/cdp/CdpScreencastRecorder'
export type { CdpTraceTransport } from '../impl/cdp/CdpTraceCollector'
export {
  BrowserPerformanceTraceCategories,
  captureCdpHeapSnapshot,
  CdpTraceCollector,
  createWebContentsCdpTraceTransport,
} from '../impl/cdp/CdpTraceCollector'
export type {
  CdpWebSocketLike,
  CdpWebSocketTransportConnectOptions,
  CdpWebSocketTransportOptions,
} from '../impl/cdp/CdpWebSocketTransport'
export { CdpWebSocketTransport } from '../impl/cdp/CdpWebSocketTransport'
export type { CdpBrowserRuntimeOptions, CdpWorkspaceFileAccess } from '../impl/CdpBrowserRuntime'
export { CdpBrowserRuntime } from '../impl/CdpBrowserRuntime'
export {
  BrowserPerformanceOrchestrator,
  extractKeyMetricsFromSummary,
} from '../impl/engines/BrowserPerformanceOrchestrator'
export type {
  BrowserParsedTraceRecording,
  BrowserTraceParseMetadata,
} from '../impl/engines/BrowserPerformanceTraceEngine'
export {
  BrowserPerformanceTraceEngine,
  formatBrowserTraceInsight,
  formatBrowserTraceSummary,
  serializeBrowserTraceToGzip,
} from '../impl/engines/BrowserPerformanceTraceEngine'
export type {
  BrowserPointerPoint,
  BrowserTargetActionClickMode,
  BrowserTargetActionInternalEffectSnapshot,
} from '../impl/engines/CdpInteractionEngine'
export { CdpInteractionEngine } from '../impl/engines/CdpInteractionEngine'
export type { BrowserDiagnosticsLimits } from '../impl/engines/CdpPageDataEngine'
export { CdpPageDataEngine } from '../impl/engines/CdpPageDataEngine'
export { CdpScreenshotEngine } from '../impl/engines/CdpScreenshotEngine'
export type {
  BrowserActionPolicyDecision,
  BrowserActionPolicyDecisionKind,
  BrowserActionPolicyRequest,
} from '../impl/policies/BrowserActionPolicy'
export { checkBrowserActionPolicy } from '../impl/policies/BrowserActionPolicy'
export type {
  BrowserActivityCoordinatorOptions,
  BrowserUserActivityWaitResult,
  BrowserUserActivityWaitState,
} from '../impl/session/BrowserActivityCoordinator'
export { BrowserActivityCoordinator } from '../impl/session/BrowserActivityCoordinator'
export { BrowserPendingEventsBroker } from '../impl/session/BrowserPendingEventsBroker'
export type { BrowserSessionActionOptions } from '../impl/session/BrowserSessionActionQueue'
export { BrowserSessionActionQueue } from '../impl/session/BrowserSessionActionQueue'
export { BrowserTargetRefStore } from '../impl/session/BrowserTargetRefStore'
export type { BrowserUserScriptAccess } from '../impl/workspace/BrowserUserScriptManager'
export {
  BrowserUserScriptIndexPath,
  BrowserUserScriptManager,
  browserUserScriptMatchesUrl,
  browserUserScriptPatternMatches,
  BrowserUserScriptStoreVersion,
} from '../impl/workspace/BrowserUserScriptManager'
export type {
  BrowserWorkspaceArtifactAccess,
} from '../impl/workspace/BrowserWorkspaceArtifactManager'
export {
  BrowserWorkspaceArtifactDirectoryMap,
  BrowserWorkspaceArtifactFormatExtensionMap,
  BrowserWorkspaceArtifactManager,
  BrowserWorkspaceManifestPath,
  BrowserWorkspaceManifestVersion,
  buildBrowserArtifactRelativePath,
  buildBrowserPageSnapshotName,
  buildBrowserRecipeSkeletonName,
  createBrowserWorkspaceArtifactAccess,
} from '../impl/workspace/BrowserWorkspaceArtifactManager'
export {
  BrowserWorkspaceFileAccess,
  createBrowserSiteWorkspaceFileAccess,
  createBrowserWorkspaceFileAccess,
} from '../impl/workspace/BrowserWorkspaceFileAccess'
export type {
  BrowserActionPolicyConfig,
  BrowserAutomationMode,
  BrowserCaptureScreenshotOptions,
  BrowserClickCoordinatesOptions,
  BrowserClickCoordinatesResult,
  BrowserColorScheme,
  BrowserCookieScope,
  BrowserDomStabilityOptions,
  BrowserDragCoordinatesOptions,
  BrowserDragEndpointResult,
  BrowserDragFailureReason,
  BrowserDragOptions,
  BrowserDragResult,
  BrowserElementFrameHint,
  BrowserElementQueryOptions,
  BrowserElementQueryResult,
  BrowserElementSelection,
  BrowserElementSelectionRect,
  BrowserElementSelectionSnapshot,
  BrowserElementSelectionStep,
  BrowserElementTargetHint,
  BrowserEmulationOptions,
  BrowserEmulationResult,
  BrowserEvaluateScriptMode,
  BrowserEvaluateScriptOptions,
  BrowserEvaluateScriptResult,
  BrowserExportPagePdfOptions,
  BrowserExportPagePdfResult,
  BrowserExtractPageContentOptions,
  BrowserExtractPageContentResult,
  BrowserFetchResourceOptions,
  BrowserFetchResourceResult,
  BrowserGeolocationOptions,
  BrowserGeolocationState,
  BrowserHandleDialogOptions,
  BrowserHandleDialogResult,
  BrowserHandleDownloadOptions,
  BrowserHandleDownloadResult,
  BrowserHandlePermissionOptions,
  BrowserHandlePermissionResult,
  BrowserHeapSnapshotOptions,
  BrowserHeapSnapshotResult,
  BrowserInspectPageOptions,
  BrowserKeyModifier,
  BrowserListMediaSourcesOptions,
  BrowserListMediaSourcesResult,
  BrowserListPageResourcesOptions,
  BrowserListPageResourcesResult,
  BrowserLoginDetection,
  BrowserLoginGateRecord,
  BrowserMediaSourceItem,
  BrowserMediaSourceKind,
  BrowserMouseButton,
  BrowserMoveMouseOptions,
  BrowserMoveMouseResult,
  BrowserNavigationHistoryEntry,
  BrowserNavigationHistoryRestore,
  BrowserNetworkCaptureNotice,
  BrowserNetworkControlOptions,
  BrowserNetworkControlResult,
  BrowserNetworkFailureSnapshot,
  BrowserNetworkMockResponse,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkRequestDetailsResult,
  BrowserNetworkRequestResponseBodySnapshot,
  BrowserNetworkRequestSnapshot,
  BrowserNetworkResponseBodyOptions,
  BrowserNetworkResponseBodyResult,
  BrowserNetworkResponseSnapshot,
  BrowserNetworkThrottlingPreset,
  BrowserObserveActionsResult,
  BrowserObservedActionCandidate,
  BrowserObservedActionCandidateBase,
  BrowserObservedActionInput,
  BrowserObservedActionKind,
  BrowserObservedActionPreview,
  BrowserObservedActionReplay,
  BrowserObservedActionSource,
  BrowserObservedTargetActionCandidate,
  BrowserObservedTargetActionReplay,
  BrowserObservedUploadCandidate,
  BrowserObservedUploadInput,
  BrowserObservedUploadReplay,
  BrowserOriginStorage,
  BrowserPageAction,
  BrowserPageActionRole,
  BrowserPageContentFormat,
  BrowserPageDiagnosticEntry,
  BrowserPageDiagnosticKind,
  BrowserPageDiagnosticLevel,
  BrowserPageDiagnostics,
  BrowserPageDiagnosticsOptions,
  BrowserPageDiagnosticsSummary,
  BrowserPageFormField,
  BrowserPageHeading,
  BrowserPageInspection,
  BrowserPageLink,
  BrowserPageNavigationAction,
  BrowserPageNavigationOptions,
  BrowserPageNavigationResult,
  BrowserPagePreviewFrame,
  BrowserPagePreviewPointerEvent,
  BrowserPagePreviewStreamEvent,
  BrowserPageResourceIframe,
  BrowserPageResourceLink,
  BrowserPageResourceOrigins,
  BrowserPageScrollDirection,
  BrowserPageScrollOptions,
  BrowserPageScrollResult,
  BrowserPageSnapshot,
  BrowserPageSnapshotSource,
  BrowserPageStabilityResult,
  BrowserPageStorageOptions,
  BrowserPageStorageResult,
  BrowserPageTargetInfo,
  BrowserPageTargetsResult,
  BrowserPageWaitLoadState,
  BrowserPageWaitOptions,
  BrowserPageWaitResult,
  BrowserPageWindowState,
  BrowserPageZoomAction,
  BrowserPageZoomOptions,
  BrowserPageZoomResult,
  BrowserPendingEventKind,
  BrowserPendingEventsResult,
  BrowserPendingEventSummary,
  BrowserPerformanceInsightOptions,
  BrowserPerformanceInsightResult,
  BrowserPerformanceTraceStartOptions,
  BrowserPerformanceTraceStartResult,
  BrowserPerformanceTraceStopResult,
  BrowserPressKeyOptions,
  BrowserPressKeyResult,
  BrowserQueriedElement,
  BrowserRecipeDryRunMissingInput,
  BrowserRecipeDryRunStep,
  BrowserRecipeDryRunSummary,
  BrowserRecipeSkeleton,
  BrowserRecipeSkeletonLink,
  BrowserRecipeSkeletonPreview,
  BrowserRecipeSkeletonStep,
  BrowserRecipeSkeletonStepInput,
  BrowserRecipeSkeletonStepKind,
  BrowserReducedMotion,
  BrowserSaveRecipeStepRequest,
  BrowserSaveRecipeStepResult,
  BrowserScreencastStartOptions,
  BrowserScreencastStartResult,
  BrowserScreencastStopOptions,
  BrowserScreencastStopResult,
  BrowserScreenshotArtifact,
  BrowserScreenshotCaptureRegion,
  BrowserScreenshotDiff,
  BrowserScreenshotElementLabel,
  BrowserScreenshotElementLabelOptions,
  BrowserScreenshotElementLegendItem,
  BrowserScreenshotFullPageOptions,
  BrowserScreenshotMetadata,
  BrowserScreenshotModelCoordinateMap,
  BrowserScreenshotModelImage,
  BrowserScreenshotModelImageOptions,
  BrowserScreenshotRect,
  BrowserScreenshotRegionOptions,
  BrowserSearchEngineId,
  BrowserSiteContext,
  BrowserStorageEntry,
  BrowserStorageScope,
  BrowserSwitchPageTargetOptions,
  BrowserSwitchPageTargetResult,
  BrowserTargetActionEffect,
  BrowserTargetActionEffectSnapshot,
  BrowserTargetActionKind,
  BrowserTargetActionOptions,
  BrowserTargetActionResult,
  BrowserTargetActionTextDiff,
  BrowserTargetActionValue,
  BrowserTurnContextDeltaSource,
  BrowserTurnContextPendingEvents,
  BrowserTurnContextSnapshot,
  BrowserTurnContextSourcePeekInput,
  BrowserTurnContextSourcePeekResult,
  BrowserTypeTextOptions,
  BrowserTypeTextResult,
  BrowserUploadFileOptions,
  BrowserUploadFileResult,
  BrowserUserActivityEvent,
  BrowserUserActivityItem,
  BrowserUserActivityKind,
  BrowserUserActivitySummary,
  BrowserUserScriptDraft,
  BrowserUserScriptLastRun,
  BrowserUserScriptManageRequest,
  BrowserUserScriptMutationResult,
  BrowserUserScriptOverview,
  BrowserUserScriptPatch,
  BrowserUserScriptRecord,
  BrowserUserScriptRunAt,
  BrowserUserScriptRunStatus,
  BrowserUserScriptSource,
  BrowserUserScriptWorld,
  BrowserViewportOptions,
  BrowserViewportResult,
  BrowserWaitForSelectorOptions,
  BrowserWaitForSelectorResult,
  BrowserWaitForSelectorState,
  BrowserWorkspaceArtifactFormat,
  BrowserWorkspaceArtifactKind,
  BrowserWorkspaceArtifactListItem,
  BrowserWorkspaceArtifactRecord,
  BrowserWorkspaceArtifactsOverview,
  BrowserWorkspaceManifest,
  ProjectReadFileResult,
  WorkspaceFileChangeDescriptor,
  WorkspaceFileEntry,
  WorkspaceListOptions,
  WorkspaceWriteFileOptions,
  WorkspaceWriteFileResult,
} from '../types/browser'
export type { BrowserPageDriverClickCoordinatesOptions, BrowserPageDriverCookie, BrowserPageDriverCookieOptions, BrowserPageDriverDiagnosticsOptions, BrowserPageDriverDownloadEvent, BrowserPageDriverDownloadListener, BrowserPageDriverDragCoordinatesOptions, BrowserPageDriverEmulationState, BrowserPageDriverFetchResourceOptions, BrowserPageDriverFetchResourceResult, BrowserPageDriverFileInputOptions, BrowserPageDriverKind, BrowserPageDriverMoveMouseOptions, BrowserPageDriverNetworkCaptureState, BrowserPageDriverNetworkControlState, BrowserPageDriverNetworkIdleOptions, BrowserPageDriverNetworkRequestDetailsResult, BrowserPageDriverNetworkResponseBodyResult, BrowserPageDriverPdfOptions, BrowserPageDriverPointerEvent, BrowserPageDriverPointerListener, BrowserPageDriverScreenshot, BrowserPageDriverScreenshotOptions, BrowserPageDriverState, BrowserPageDriverStorageOriginOptions, BrowserSystemPointerMoveOptions } from '../types/driver'
export type {
  BrowserPageDriverKernel,
  BrowserPageDriverSession,
  ExternalBrowserPageSession,
} from '../types/runtime'
export {
  buildBrowserSearchUrl,
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isBrowserNavigationLikeInput,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
} from '../utils/address'
export { normalizeBrowserArtifactJsonPath, normalizeBrowserRecipePath } from '../utils/artifacts'
export type { CdpSend } from '../utils/cdp/emulation'
export {
  applyCdpEmulation,
  CdpNetworkThrottlingPresets,
  createDefaultCdpEmulationState,
  syncCdpNetworkConditions,
} from '../utils/cdp/emulation'
export {
  buildBrowserNetworkCaptureNotice,
  clearBrowserDiagnosticEntries,
  takeBrowserDiagnosticWindow,
} from '../utils/diagnostics'
export { BrowserViewNotAttachedReason, isBrowserViewNotAttachedError } from '../utils/errors'
export { normalizeBrowserPressKeyOptions } from '../utils/keyboard'
export { buildBrowserLoginGateMessage, buildBrowserLoginGateRecord, buildBrowserLoginGateRiskScope, resolveBrowserLoginGateOrigin } from '../utils/login-gate.js'
export {
  clampInteger,
  clampNumber,
  clampZoomFactor,
  readBoundedString,
  readFiniteNumber,
} from '../utils/numbers'
export { buildActionEffectSnapshotScript } from '../utils/page-scripts/action-effect'
export { buildDragTargetScript } from '../utils/page-scripts/drag'
export { buildElementQueryScript } from '../utils/page-scripts/element-query'
export {
  BrowserEvaluateMaxResultChars,
  BrowserEvaluateSimplifyMaxDepth,
  BrowserEvaluateSimplifyMaxEntries,
  buildEvaluateScript,
  describeBrowserEvaluatedElement,
  precheckBrowserInlineScriptSyntax,
  simplifyBrowserEvaluatedValue,
} from '../utils/page-scripts/evaluate'
export { buildListExtractionScript, buildPageContentExtractionScript, buildPageResourcesScript, buildTableExtractionScript } from '../utils/page-scripts/extraction'
export { buildResolveFileInputScript } from '../utils/page-scripts/file-upload'
export { buildBrowserInlineInferenceToolkitSnippet } from '../utils/page-scripts/inference-toolkit'
export { buildInspectionScript } from '../utils/page-scripts/inspection'
export {
  browserLoginDetectionScriptFragment,
  buildBrowserLoginDetectionScript,
} from '../utils/page-scripts/login-detection'
export { buildListMediaSourcesScript } from '../utils/page-scripts/media-sources'
export { buildPageWaitScript } from '../utils/page-scripts/page-wait'
export { buildScrollScript } from '../utils/page-scripts/scroll'
export { buildPageStorageScript } from '../utils/page-scripts/storage'
export type { BrowserTargetActionScriptBuildOptions } from '../utils/page-scripts/target-action'
export { buildTargetActionScript } from '../utils/page-scripts/target-action'
export { buildHighlightFromTargetScript, buildHighlightScript } from '../utils/page-scripts/target-highlight'
export { buildWaitForSelectorScript } from '../utils/page-scripts/wait-for-selector'
export {
  BrowserFallbackVirtualPointer,
  buildBrowserFallbackVirtualPointerSvg,
} from '../utils/pointer'
export {
  BrowserAutomationModes,
  BrowserSearchEngineIds,
  DefaultBrowserAutomationMode,
  DefaultBrowserSearchEngine,
  isBrowserAutomationMode,
  isBrowserSearchEngineId,
  resolveBrowserAutomationMode,
  resolveBrowserSearchEngineId,
} from '../utils/preferences'
export { assertSameBrowserOrigin, buildRecipeSkeletonPreview } from '../utils/recipes/preview'
export type { BrowserRecipeTemplate } from '../utils/recipes/skeleton'
export { applyBrowserRecipeTemplate, buildBrowserRecipeSkeleton } from '../utils/recipes/skeleton'
export type {
  BrowserScreenshotPolicyDefaults,
  BrowserScreenshotPolicyOptions,
} from '../utils/screenshot-options'
export {
  BrowserScreenshotDefaultDomStable,
  BrowserScreenshotDefaultModelImage,
  BrowserScreenshotDefaultNetworkIdleMs,
  buildBrowserScreenshotOptions,
} from '../utils/screenshot-options'
export { resolveExternalPageUrl } from '../utils/url'
export type { BrowserViewportDeviceMetrics } from '../utils/viewport'
export { buildBrowserViewportDeviceMetrics, DEFAULT_BROWSER_VIEWPORT } from '../utils/viewport'
export type { BrowserWorkspacePath } from '../utils/workspace-paths'
export {
  getRelativePathInsideRoot,
  resolveBrowserWorkspacePath,
  resolveWorkspaceFilePath,
  toPortableRelativePath,
} from '../utils/workspace-paths'
// 账本与装饰器已合成一个类；旧名字留着不动消费方，收口那一轮随迁移表改成 createBrowserLoginGate
export type { BrowserPageDriver, BrowserPageDriverDownloadItem, BrowserSystemPointerDriver } from '../contract/requires.js'
export type { BrowserExternalPageLauncher } from '../contract/requires.js'
export { BrowserLoginGate as BrowserLoginGateLedger } from '../impl/workspace/BrowserLoginGate.js'
