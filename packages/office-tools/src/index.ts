/**
 * office/index.ts — Office 子模块统一出口
 *
 * 聚合 Word / PPT / Excel / PDF 四个工具模块，对外暴露 officeTools 对象。
 */

export { officeTools } from './Collection'
export {
  createOfficeToolsKernelModule,
  type CreateOfficeToolsKernelModuleOptions,
  type OfficeToolContextResolver,
  OfficeToolsCapability,
  type OfficeToolsCapabilityService,
} from './kernel-module'
export {
  MarkItDownBinaryResolver,
  markItDownBinaryResolver,
  type MarkItDownBinaryResolverOptions,
  type MarkItDownLaunchSpec,
} from './markitdownResolver'
export type { ConvertDocumentToMarkdownInput } from './markitdownTool'
export type * from './OfficeContracts'
export {
  getRelativePathInsideOfficeRoot,
  OfficePlatformCompatibility,
  officePlatformCompatibility,
} from './OfficePlatformCompatibility'
export {
  type OfficeResourceId,
  type OfficeResourceRuntime,
  officeResourceRuntime,
  OfficeResourceRuntimeRegistry,
  type OfficeResourceRuntimeRegistryOptions,
} from './OfficeResourceRuntime'
export type {
  NormalizedWordInput,
  NormalizeWordInputResult,
  OfficeOutput,
  OfficeSystemApi,
  OfficeToolContext,
  OfficeToolPermission,
  OfficeWorkspaceApi,
  ToolContext,
  VelaTool,
} from './officeShared'
export {
  AppError,
  basename,
  buildMissingSystemToolResult,
  buildWorkspaceMutationSkippedResult,
  cleanupNormalizedWordInput,
  commandExecutable,
  copyFile,
  copyOfficeOutput,
  createBrowserOnlineAlternative,
  createCommandFailureResult,
  dirname,
  extname,
  findAvailableCommand,
  findGeneratedOfficeFile,
  findGeneratedPdf,
  getFileStats,
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  normalizeExtensionPath,
  normalizeWordInputToDocx,
  outputPathSchema,
  prepareOfficeOutputPath,
  readdir,
  requireFromOfficeModule,
  resolve,
  resolveLibreOfficeCommand,
  resolveOfficeInputPath,
  resolveOfficeInputPathWithExtensions,
  rm,
  runLibreOfficeSystemCommand,
  runOfficeSystemCommand,
  runWithDirectory,
  sep,
  tmpdir,
  toolRequiresWorkspace,
  writeFile,
  writeOfficeBuffer,
  z,
} from './officeShared'
export type {
  ConvertPdfToWordInput,
  ConvertWordToPdfInput,
  CreateLatexPdfInput,
  EditPdfDocumentInput,
  LatexCompiler,
  PdfMetadataInput,
  PdfTextStampInput,
} from './pdfTools'
export type {
  CreatePresentationInput,
  PptElement,
  PptTextProps,
  PresentationSlideInput,
  PresentationTemplate,
} from './presentationTool'
export type { PreviewOfficeDocumentInput } from './previewTool'
export type {
  CreateSpreadsheetInput,
  ExcelAlignment,
  ExcelBorders,
  ExcelCellInput,
  ExcelColumnDef,
  ExcelFill,
  ExcelFont,
  SpreadsheetSheetInput,
} from './spreadsheetTool'
export type {
  CreateWordDocumentInput,
  WordBlock,
  WordDocumentMetadata,
  WordDocumentProfile,
  WordTableCellInput,
  WordTextRun,
} from './wordTool'
