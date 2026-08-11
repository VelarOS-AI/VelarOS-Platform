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

function VelarScriptMarkIcon({
  size = 14,
  color = 'currentColor',
  mirrored = false,
  weight: _weight,
  style,
  ...props
}: IconProps): ReactElement {
  const transform = mirrored
    ? [style?.transform, 'scaleX(-1)'].filter(Boolean).join(' ')
    : style?.transform

  return (
    <svg
      {...props}
      aria-hidden={props['aria-label'] ? undefined : true}
      data-velarscript-mark="true"
      width={size}
      height={size}
      viewBox="85 113 346 290"
      style={transform ? { ...style, transform, transformOrigin: 'center' } : style}
    >
      <path
        fill={color}
        d="M97 128C98 126 99 125 102 125h94c9 0 15 4 19 13l42 81c6 10 16 17 27 24 12 9 18 21 17 35 0 8-4 16-9 24l-55 81L98 134c-2-3-2-5-1-6Z"
      />
      <path
        fill={color}
        d="M271 180c3-11 10-22 17-29l17-17c6-6 11-9 19-9h95l-86 153c1-9-1-19-6-27-4-7-12-14-19-20l-25-22c-10-8-14-18-12-29Z"
      />
      <path
        fill={color}
        d="m237 383 82-81-46 84c-5 4-11 5-18 5s-13-3-18-8Z"
      />
    </svg>
  )
}

function getIconComponent(input: {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}): ComponentType<IconProps> {
  switch (getFilePresentationVariant(input)) {
    case 'typescript':
      return FileTsIcon
    case 'velarscript':
      return VelarScriptMarkIcon
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
