/**
 * 壁纸层：一个 z-index:-1 的 fixed 容器，位于 body 直接子级、AppFrame 之下。
 *
 *   <div data-wp-layer>            position:fixed; inset:0; z-index:-1; pointer-events:none
 *     <div data-wp-media>          承载背景图（CSS background）或 <video>；blur/brightness 作用于此
 *     <div data-wp-dim>            压暗叠层（rgba 黑，opacity 由设置驱动）
 *   </div>
 *
 * 层内元素均带 data-plugin 标记（与客户端模块系统的样式/资源归属约定一致）。
 *
 * 性能约定（不降分辨率/帧率）：
 *  - 视频解码只在「壁纸激活且窗口可见」时进行：停用或窗口隐藏即暂停，
 *    恢复可见自动续播（解码是最大的 CPU/GPU 开销）
 *  - 样式写入带脏检查：设置未变化的属性不重复写，避免无谓的重绘/重排
 *  - 模糊 > 0 时才提升 media 为合成层（will-change），否则不占显存
 */

import type { FillMode, WallpaperSettings } from './state'
import { isActive } from './state'
import { PLUGIN_PKG } from './identity'

export const LAYER_PLUGIN_ID = PLUGIN_PKG

let layer: HTMLDivElement | null = null
let media: HTMLDivElement | null = null
let dim: HTMLDivElement | null = null
let videoEl: HTMLVideoElement | null = null
let mediaUrl: string | null = null
let mediaType: 'image' | 'video' | null = null

/** 上一次写入的样式值（脏检查：相同值不重写，避免样式抖动引发重绘） */
let lastFill = ''
let lastFilter = ''
let lastTransform = ''
let lastDimOpacity = ''
let lastObjectFit = ''
/** 视频当前应处于播放还是暂停（由激活状态与窗口可见性共同决定） */
let wantPlaying = false
let visibilityHooked = false

function ensureElement(tag: string, attr: string): HTMLElement {
  const el = document.createElement(tag)
  el.setAttribute(attr, '')
  el.setAttribute('data-plugin', LAYER_PLUGIN_ID)
  return el
}

/** 按需暂停/恢复视频：激活且窗口可见才解码。 */
function syncVideoPlayback(): void {
  if (!videoEl) return
  const shouldPlay = wantPlaying && !document.hidden
  if (shouldPlay && videoEl.paused) void videoEl.play().catch(() => {
    // 自动播放被拒绝时静默：用户交互后 <video> 仍可播放并驱动取色采样
  })
  else if (!shouldPlay && !videoEl.paused) videoEl.pause()
}

function onVisibilityChange(): void {
  syncVideoPlayback()
}

export function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer
  layer = ensureElement('div', 'data-wp-layer') as HTMLDivElement
  media = ensureElement('div', 'data-wp-media') as HTMLDivElement
  dim = ensureElement('div', 'data-wp-dim') as HTMLDivElement
  layer.append(media, dim)
  ;(document.body ?? document.documentElement).appendChild(layer)
  if (!visibilityHooked && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityHooked = true
  }
  return layer
}

export function disposeLayer(): void {
  if (typeof document !== 'undefined' && visibilityHooked) {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityHooked = false
  }
  if (videoEl) videoEl.pause()
  videoEl = null
  mediaUrl = null
  mediaType = null
  layer?.remove()
  layer = null
  media = null
  dim = null
  lastFill = lastFilter = lastTransform = lastDimOpacity = lastObjectFit = ''
}

function imageBackgroundStyle(fit: FillMode): string {
  switch (fit) {
    case 'contain':
      return 'no-repeat center / contain'
    case 'fill':
      return 'no-repeat center / 100% 100%'
    case 'tile':
      return 'repeat top left / auto'
    case 'cover':
    default:
      return 'no-repeat center / cover'
  }
}

function videoObjectFit(fit: FillMode): string {
  // <video> 无法平铺，tile 按 cover 处理
  return fit === 'contain' ? 'contain' : fit === 'fill' ? 'fill' : 'cover'
}

/** 当前媒体为视频时返回元素（供取色模块采样）。 */
export function getVideoElement(): HTMLVideoElement | null {
  return videoEl
}

/** 替换媒体内容：图片走 CSS background（GIF/APNG/动图 WebP 原生播放），视频走 <video>。 */
export function setMedia(url: string | null, type: 'image' | 'video' | null): void {
  ensureLayer()
  if (!media) return
  videoEl?.pause()
  videoEl?.remove()
  videoEl = null
  mediaUrl = url
  mediaType = type
  media.style.background = ''
  media.style.filter = ''
  media.style.transform = ''
  lastFill = lastFilter = lastTransform = lastObjectFit = ''
  if (!url || !type) {
    syncVideoPlayback()
    return
  }

  if (type === 'image') return
  const video = document.createElement('video')
  video.setAttribute('data-plugin', LAYER_PLUGIN_ID)
  video.src = url
  video.muted = true
  video.loop = true
  video.autoplay = true
  video.setAttribute('playsinline', '')
  video.setAttribute('aria-hidden', 'true')
  video.disableRemotePlayback = true
  video.disablePictureInPicture = true
  video.preload = 'auto'
  video.style.width = '100%'
  video.style.height = '100%'
  video.style.display = 'block'
  media.appendChild(video)
  videoEl = video
  syncVideoPlayback()
}

/** 把设置投影到层上（样式写入带脏检查）。 */
export function updateLayer(s: WallpaperSettings): void {
  const l = ensureLayer()
  if (!media || !dim) return
  const active = isActive(s)

  l.style.display = active ? '' : 'none'

  // 激活状态变化驱动视频播放/暂停（停用即停解码，这是最大的开销项）
  const nowWantPlaying = active && mediaType === 'video'
  if (nowWantPlaying !== wantPlaying) {
    wantPlaying = nowWantPlaying
    syncVideoPlayback()
  }
  if (!active || !mediaType) return

  // 模糊 + 亮度只作用于媒体层，与界面 token 完全解耦；模糊时轻微放大避免边缘露底
  const blurPx = Math.max(0, Math.min(40, s.blur))
  const brightness = Math.max(0.2, Math.min(2, s.brightness / 100))
  const filter = `blur(${blurPx}px) brightness(${brightness})`
  if (filter !== lastFilter) {
    media.style.filter = filter
    lastFilter = filter
  }
  const scale = 1 + Math.min(blurPx, 30) / 200
  const transform = blurPx > 0 ? `scale(${scale.toFixed(3)})` : ''
  if (transform !== lastTransform) {
    media.style.transform = transform
    lastTransform = transform
    // 仅模糊时提升合成层（GPU 直合成滤镜），无模糊时不占显存
    media.style.willChange = blurPx > 0 ? 'filter, transform' : ''
  }

  const dimOpacity = String(Math.max(0, Math.min(90, s.dim)) / 100)
  if (dimOpacity !== lastDimOpacity) {
    dim.style.opacity = dimOpacity
    lastDimOpacity = dimOpacity
  }

  if (mediaType === 'image' && mediaUrl) {
    const fill = `url("${mediaUrl}") ${imageBackgroundStyle(s.fit)}`
    if (fill !== lastFill) {
      media.style.background = fill
      lastFill = fill
    }
  }
  if (videoEl) {
    const fit = videoObjectFit(s.fit)
    if (fit !== lastObjectFit) {
      videoEl.style.objectFit = fit
      lastObjectFit = fit
    }
  }
}
