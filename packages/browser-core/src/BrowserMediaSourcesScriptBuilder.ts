/**
 * 构造页面媒体 URL 枚举脚本。
 */
class BrowserMediaSourcesScriptBuilder {
  public buildListMediaSourcesScript(options: {
    limit: number
    includeDataUrls: boolean
    includeBlobUrls: boolean
  }): string {
    const payload = JSON.stringify(options)

    return `(() => {
  const payload = ${payload};
  const resolveUrl = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed, location.href).href;
    } catch {
      return null;
    }
  };
  const isFetchable = (url) => /^https?:/i.test(url);
  const seen = new Set();
  const items = [];
  const add = (entry) => {
    if (!entry?.url || seen.has(entry.url)) return;
    seen.add(entry.url);
    items.push(entry);
  };
  const readNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };
  const pushMedia = (kind, url, extra = {}) => {
    const resolved = resolveUrl(url);
    if (!resolved) return;
    if (resolved.startsWith('data:') && !payload.includeDataUrls) return;
    if (resolved.startsWith('blob:') && !payload.includeBlobUrls) return;
    add({
      kind,
      url: resolved,
      fetchable: isFetchable(resolved),
      tagName: extra.tagName ?? null,
      attribute: extra.attribute ?? null,
      alt: extra.alt ?? null,
      width: extra.width ?? null,
      height: extra.height ?? null,
    });
  };

  for (const img of Array.from(document.querySelectorAll('img'))) {
    pushMedia('image', img.currentSrc || img.src, {
      tagName: 'img',
      attribute: 'src',
      alt: img.alt || null,
      width: readNumber(img.naturalWidth || img.width),
      height: readNumber(img.naturalHeight || img.height),
    });
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      for (const part of srcset.split(',')) {
        const candidate = part.trim().split(/\\s+/)[0];
        pushMedia('image', candidate, { tagName: 'img', attribute: 'srcset' });
      }
    }
  }

  for (const video of Array.from(document.querySelectorAll('video'))) {
    pushMedia('video', video.currentSrc || video.src, {
      tagName: 'video',
      attribute: 'src',
      width: readNumber(video.videoWidth || video.width),
      height: readNumber(video.videoHeight || video.height),
    });
    for (const source of Array.from(video.querySelectorAll('source'))) {
      pushMedia('video', source.src || source.getAttribute('src'), {
        tagName: 'source',
        attribute: 'src',
      });
    }
  }

  for (const audio of Array.from(document.querySelectorAll('audio'))) {
    pushMedia('audio', audio.currentSrc || audio.src, { tagName: 'audio', attribute: 'src' });
    for (const source of Array.from(audio.querySelectorAll('source'))) {
      pushMedia('audio', source.src || source.getAttribute('src'), {
        tagName: 'source',
        attribute: 'src',
      });
    }
  }

  for (const picture of Array.from(document.querySelectorAll('picture source'))) {
    pushMedia('image', picture.src || picture.getAttribute('srcset')?.split(',')[0]?.trim().split(/\\s+/)[0], {
      tagName: 'source',
      attribute: 'src',
    });
  }

  const mediaPattern = /\\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|m3u8|mp3|wav|ogg)(?:[?#]|$)/i;
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href || !mediaPattern.test(href)) continue;
    pushMedia(href.includes('mp4') || href.includes('webm') || href.includes('m3u8') ? 'video' : 'image', href, {
      tagName: 'a',
      attribute: 'href',
    });
  }

  const truncated = items.length > payload.limit;
  return {
    items: items.slice(0, payload.limit),
    truncated,
  };
})()`
  }
}

export { BrowserMediaSourcesScriptBuilder }
