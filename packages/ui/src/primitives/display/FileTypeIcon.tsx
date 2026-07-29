/**
 * 按文件类型渲染带品牌色的文件图标。
 */
import type { IconProps } from '@phosphor-icons/react'
import {
  BracketsCurlyIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCIcon,
  FileCodeIcon,
  FileCppIcon,
  FileCSharpIcon,
  FileCssIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileIcon,
  FileImageIcon,
  FileJsIcon,
  FileJsxIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FilePyIcon,
  FileRsIcon,
  FileSqlIcon,
  FileTextIcon,
  FileTsIcon,
  FileTsxIcon,
  FileVideoIcon,
  FileVueIcon,
  FileXlsIcon,
} from '@phosphor-icons/react'
import type { ComponentType, ReactElement } from 'react'

import {
  getFilePresentationColor,
  getFilePresentationKind,
  getFilePresentationVariant,
} from '../../utils/filePresentation'

interface FileTypeIconProps extends Omit<IconProps, 'children'> {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}

function getIconComponent(input: {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}): ComponentType<IconProps> {
  switch (getFilePresentationVariant(input)) {
    case 'typescript':
      return FileTsIcon
    case 'tsx':
      return FileTsxIcon
    case 'javascript':
      return FileJsIcon
    case 'jsx':
      return FileJsxIcon
    case 'json':
      return BracketsCurlyIcon
    case 'css':
    case 'scss':
      return FileCssIcon
    case 'python':
      return FilePyIcon
    case 'rust':
      return FileRsIcon
    case 'vue':
      return FileVueIcon
    case 'sql':
      return FileSqlIcon
    case 'csharp':
      return FileCSharpIcon
    case 'cpp':
      return FileCppIcon
    case 'c':
      return FileCIcon
    case 'archive':
      return FileArchiveIcon
    case 'audio':
      return FileAudioIcon
    case 'code':
      return FileCodeIcon
    case 'csv':
      return FileCsvIcon
    case 'document':
      return FileDocIcon
    case 'html':
      return FileHtmlIcon
    case 'image':
      return FileImageIcon
    case 'markdown':
      return FileMdIcon
    case 'pdf':
      return FilePdfIcon
    case 'presentation':
      return FilePptIcon
    case 'spreadsheet':
      return FileXlsIcon
    case 'text':
      return FileTextIcon
    case 'video':
      return FileVideoIcon
    case 'generic':
    default:
      return getFilePresentationKind(input) === 'code' ? FileCodeIcon : FileIcon
  }
}

export function FileTypeIcon({
  fileName,
  mediaType,
  size = 14,
  weight = 'duotone',
  color,
  ...props
}: FileTypeIconProps): ReactElement {
  const Icon = getIconComponent({ fileName, mediaType })
  return (
    <Icon
      size={size}
      weight={weight}
      color={color ?? getFilePresentationColor({ fileName, mediaType })}
      {...props}
    />
  )
}
