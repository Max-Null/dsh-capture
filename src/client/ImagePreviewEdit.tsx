/**
 * ImagePreviewEdit: 官方「原图预览」(ImageLightbox) 的编辑入口。
 *
 * MutationObserver 发现预览 dialog（role=dialog + aria-label 原图预览 /
 * Original image preview —— 官方文案，不依赖 CSS hash，草稿附件预览与
 * 消息图片预览共用同一个 ImageLightbox）→ 注入「编辑」按钮 → 点击打开
 * CaptureOverlay 整图模式（immediate：跳过框选直接标注）→ 完成时：
 *   - 有标注：投递一张编辑图到输入框（原图已在对话里，不再投原图）；
 *   - 无标注：视为未修改，直接关闭不投递（2026-08-24 用户决定）。
 * Escape / 取消逐级回退到底 = 放弃编辑回到原预览。
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaptureOverlay } from './CaptureOverlay'
import { deliverToComposer } from './delivery'

const PREVIEW_LABELS = /^(原图预览|Original image preview)$/

const EDIT_BTN_CSS = [
  '.dsh-img-edit-btn{position:fixed;top:20px;right:64px;z-index:1;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(255,255,255,.14));border-radius:999px;background:var(--dsw-specific-input-major,rgba(20,24,32,.92));color:var(--dsw-alias-label-primary,#e8eaed);cursor:pointer;padding:0}',
  '.dsh-img-edit-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff)}',
].join('')

const STYLE_ID = '@max-null/dsh-capture/image-edit.css'
function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-capture'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = EDIT_BTN_CSS
  document.head.appendChild(tag)
}

/** 正在编辑的图片（blob/dataUrl src + 自然尺寸）+ 来源预览 dialog。 */
interface EditTarget {
  src: string
  width: number
  height: number
  dialog: HTMLElement | null
}

/** 触发官方面板关闭：点预览 dialog 内的关闭按钮（aria-label 文案稳定）。
 *  找不到按钮时静默跳过——dialog 由 React 状态驱动,只能经它的控件关闭。 */
function closePreviewDialog(dialog: HTMLElement | null): void {
  if (dialog === null || !dialog.isConnected) return
  for (const btn of Array.from(dialog.querySelectorAll('button'))) {
    if (/^(关闭原图预览|Close original image preview)$/.test(btn.getAttribute('aria-label') ?? '')) {
      btn.click()
      return
    }
  }
}

/** 常驻注入宿主：观察预览对话框并注入编辑按钮；零视觉输出（null portal）。 */
export function ImagePreviewEditHost(): ReactNode {
  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  // 供 MutationObserver 闭包读取的实时引用。
  const editRef = useRef<EditTarget | null>(edit)
  editRef.current = edit

  useEffect(() => {
    ensureStyle()
    const openEdit = (src: string, dialog: HTMLElement | null): void => {
      if (busyRef.current || editRef.current !== null) return
      busyRef.current = true
      const probe = new Image()
      probe.onload = () => {
        busyRef.current = false
        setEdit({ src, width: probe.naturalWidth, height: probe.naturalHeight, dialog })
      }
      probe.onerror = () => {
        busyRef.current = false
        setError('图片加载失败，无法编辑')
      }
      probe.src = src
    }
    const injectInto = (dialog: Element, img: HTMLImageElement): boolean => {
      if (dialog.querySelector('[data-dsh-image-edit]') !== null) return false
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.dshImageEdit = '1'
      btn.className = 'dsh-img-edit-btn'
      btn.setAttribute('aria-label', '编辑图片')
      btn.title = '标注编辑这张图片'
      btn.innerHTML = '✎'
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        openEdit(img.src, img.closest('[role="dialog"]'))
      })
      dialog.appendChild(btn)
      return true
    }
    const scan = (): void => {
      for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        if (!PREVIEW_LABELS.test(dialog.getAttribute('aria-label') ?? '')) continue
        const img = dialog.querySelector('img')
        if (img !== null) injectInto(dialog, img)
      }
    }
    const observer = new MutationObserver(scan)
    if (document.body !== null) {
      observer.observe(document.body, { childList: true, subtree: true })
      scan()
    }
    return () => observer.disconnect()
  }, [])

  // 编辑浮层关闭错误提示
  useEffect(() => {
    if (error !== null) {
      const timer = window.setTimeout(() => setError(null), 2500)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [error])

  if (edit === null) return null

  const onDone = (result: { source: string, annotated?: string }): void => {
    const dialog = editRef.current?.dialog ?? null
    setEdit(null)
    // 完成即关闭来源预览窗口(编辑流程收敛;无标注=未修改,同样关闭不投递)。
    closePreviewDialog(dialog)
    // 无标注 = 未修改:不投递;有标注投一张编辑图（原图已在对话里）。
    if (result.annotated === undefined) return
    void deliverToComposer(result.annotated, 'image-edit-annotated.png').catch((err: unknown) => {
      console.warn(`[ssid-screenshot] image edit delivery failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const overlay = createElement(CaptureOverlay, {
    key: 'image-edit',
    dataUrl: edit.src,
    width: edit.width,
    height: edit.height,
    immediate: true,
    onDone,
    onCancel: () => setEdit(null),
  })

  return createPortal(
    <div>
      {overlay}
      {error !== null ? <div className="dsh-img-edit-error" style={{ position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647, padding: '6px 14px', borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover-solid,rgba(30,36,46,.95))', color: 'var(--dsw-alias-state-error-primary,#ff6b6b)', font: '13px/20px sans-serif' }}>{error}</div> : null}
    </div>,
    document.body,
  )
}
