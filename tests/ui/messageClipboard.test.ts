import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildMessageClipboardContent,
  readVelarMessageClipboard,
  VelarMessageClipboardMime,
  writeMessageClipboardContent,
} from '../../packages/ui/src/conversation/blocks/messageClipboard'
import type { ChatMessage } from '../../packages/ui/src/conversation/contracts'

function message(input: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    blocks: [],
    timestamp: 1,
    ...input,
  }
}

void describe('shared rich message clipboard', () => {
  void test('copies user text, inline image data and local files as one payload', () => {
    const content = buildMessageClipboardContent(
      message({
        blocks: [{ type: 'text', text: '请检查这些附件' }],
        attachments: [
          {
            id: 'image-1',
            kind: 'image',
            name: 'screen.png',
            mediaType: 'image/png',
            size: 3,
          },
          {
            id: 'file-1',
            kind: 'file',
            name: 'notes.md',
            mediaType: 'text/markdown',
            size: 8,
            path: '/tmp/Velar Files/notes.md',
          },
        ],
        serialized: {
          role: 'user',
          textBlocks: ['请检查这些附件'],
          toolCalls: [],
          imageAttachments: [
            {
              id: 'image-1',
              kind: 'image',
              filename: 'screen.png',
              mediaType: 'image/png',
              data: 'AQID',
              size: 3,
            },
          ],
        },
      })
    )

    assert.equal(content.assets.length, 2)
    assert.equal(content.messageText, '请检查这些附件')
    assert.equal(content.plainText, '请检查这些附件\n\nfile:///tmp/Velar%20Files/notes.md')
    assert.doesNotMatch(content.plainText, /Image:|File:/u)
    assert.doesNotMatch(content.html, /data:image\/png/u)
    assert.match(content.html, /href="file:\/\/\/tmp\/Velar%20Files\/notes\.md"/u)
    assert.equal(content.uriList, 'file:///tmp/Velar%20Files/notes.md')
  })

  void test('copies assistant generated files, model images and source links', () => {
    const content = buildMessageClipboardContent(
      message({
        role: 'assistant',
        blocks: [
          { type: 'text', text: '已经生成。' },
          {
            type: 'assistant-generated-file',
            id: 'report',
            filename: 'report.pdf',
            mediaType: 'application/pdf',
            data: 'JVBERg==',
            size: 7,
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'image:read',
            args: { path: '/tmp/chart.jpg' },
            modelImage: { mediaType: 'image/jpeg', data: '/9j/' },
          },
          {
            type: 'assistant-source',
            id: 'source-1',
            sourceType: 'url',
            url: 'https://velaros.ai/docs',
            title: 'VelarOS Docs',
          },
        ],
      })
    )

    assert.deepEqual(
      content.assets.map((asset) => [asset.kind, asset.name]),
      [
        ['file', 'report.pdf'],
        ['image', 'chart.jpg'],
      ]
    )
    assert.doesNotMatch(content.html, /data:application\/pdf|data:image\/jpeg/u)
    assert.match(content.html, /href="file:\/\/\/tmp\/chart\.jpg"/u)
    assert.match(content.html, /href="https:\/\/velaros\.ai\/docs"/u)
    assert.equal(
      content.plainText,
      '已经生成。\n\nfile:///tmp/chart.jpg\nhttps://velaros.ai/docs'
    )
  })

  void test('keeps external copy link-only and restores internal image attachments', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
    const writes: Array<Record<string, Blob>> = []
    const plainWrites: string[] = []

    class TestClipboardItem {
      public static supports(type: string): boolean {
        return type === 'image/png' || type === 'text/uri-list'
      }

      public constructor(public readonly data: Record<string, Blob>) {}
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async (items: TestClipboardItem[]) => {
            writes.push(items[0]!.data)
          },
          writeText: async (value: string) => {
            plainWrites.push(value)
          },
        },
      },
    })
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => {
        throw new Error('message clipboard must not fetch attachment data URLs')
      },
    })

    try {
      await writeMessageClipboardContent(
        buildMessageClipboardContent(
          message({
            blocks: [{ type: 'text', text: '带图复制' }],
            attachments: [
              {
                id: 'image-1',
                kind: 'image',
                name: 'screen.png',
                mediaType: 'image/png',
                size: 3,
              },
            ],
            serialized: {
              role: 'user',
              textBlocks: ['带图复制'],
              toolCalls: [],
              imageAttachments: [
                {
                  id: 'image-1',
                  kind: 'image',
                  filename: 'screen.png',
                  mediaType: 'image/png',
                  data: 'AQID',
                  size: 3,
                },
              ],
            },
          })
        )
      )
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
      if (clipboardItemDescriptor)
        Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor)
      else Reflect.deleteProperty(globalThis, 'ClipboardItem')
      if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
      else Reflect.deleteProperty(globalThis, 'fetch')
    }

    assert.equal(writes.length, 1)
    assert.deepEqual(Object.keys(writes[0]!).sort(), [
      'text/html',
      'text/plain',
    ])
    assert.equal(plainWrites.length, 0)
    assert.equal(await writes[0]!['text/plain']!.text(), '带图复制')
    const internalHtml = await writes[0]!['text/html']!.text()
    assert.doesNotMatch(internalHtml, /data:image\/png/u)
    assert.match(internalHtml, /data-velaros-message-attachments=/u)

    const restored = readVelarMessageClipboard({
      getData: (type: string) => (type === 'text/html' ? internalHtml : ''),
    } as DataTransfer)
    assert.ok(restored)
    assert.equal(restored.text, '带图复制')
    assert.equal(restored.files.length, 1)
    assert.equal(restored.files[0]!.name, 'screen.png')
    assert.equal(restored.files[0]!.type, 'image/png')
    assert.deepEqual(
      [...new Uint8Array(await restored.files[0]!.arrayBuffer())],
      [1, 2, 3]
    )
  })

  void test('restores internal path-only files without exposing placeholder prose', () => {
    const restored = readVelarMessageClipboard({
      getData: (type: string) =>
        type === VelarMessageClipboardMime
          ? JSON.stringify({
              version: 1,
              text: '检查文件',
              assets: [
                {
                  kind: 'file',
                  name: 'notes.md',
                  mediaType: 'text/markdown',
                  size: 8,
                  lastModified: 123,
                  dataUrl: null,
                  path: '/tmp/notes.md',
                },
              ],
            })
          : '',
    } as DataTransfer)

    assert.ok(restored)
    assert.equal(restored.text, '检查文件')
    assert.equal(restored.files.length, 1)
    assert.equal(restored.files[0]!.size, 8)
    assert.equal((restored.files[0] as File & { path?: string }).path, '/tmp/notes.md')
  })
})
