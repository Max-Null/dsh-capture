/**
 * CaptureOverlay: 纯 DSH（浏览器模式）的页面截图遮罩。
 *
 * 微信式单阶段交互（与壳层浮层 screenshot.html 同一套）：
 *   左键拖拽框选 → 选区定格（工具条出现）→ 同一全屏画面上任意位置拖拽画
 *   红框强调（合成时按选区裁剪）→ 回车/「完成」一次确认交付；
 *   右键/Esc 逐级回退（画框中 → 撤框 → 重选 → 退出）。
 *
 * 坐标口径：全部交互状态存「帧物理坐标」（拖拽时经 wrap 显示尺寸实时换算），
 * 渲染时换算回显示像素绘制；最终合成：裁剪选区 + 红框 clip 叠加。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/** 组件 props（width/height = getDisplayMedia track 的物理分辨率）。
 *  immediate=true 时为「整图编辑」模式：跳过框选，整图为工作区直接标注
 *  （原图预览编辑入口用）。onDone 协议 v2：{ source, annotated? } —— 原图
 *  (纯裁剪)必有；编辑图(标注合成)仅当存在标注时携带，无标注时调用方应
 *  视为「未修改」直接关闭（2026-08-24 用户决定）。 */
export interface CaptureOverlayProps {
  dataUrl: string
  width: number
  height: number
  immediate?: boolean
  onDone: (result: ShotResult) => void
  onCancel: () => void
}

export interface ShotResult {
  source: string
  annotated?: string
}

interface Point { x: number, y: number }
interface Rect { x: number, y: number, w: number, h: number }
/** 标注种类：框（矩形/椭圆）、箭头、文字。 */
type AnnoKind = 'rect' | 'ellipse' | 'arrow' | 'text'
/** 标注（物理坐标）。rect/ellipse：x/y 为左上、w/h 为宽高（已 norm）；
 *  arrow：x/y 为起点、w/h 为带方向的向量（可为负 —— 保留箭头指向）；
 *  text：x/y 为文本左上，w/h 合成时按字体测量。color 为选中色板色。 */
interface Anno {
  kind: AnnoKind
  x: number
  y: number
  w: number
  h: number
  color: string
  text?: string
}

/** 画标注色板（默认红；可见性按背景自动对比，白/黄/绿常驻）。 */
const ANNO_COLORS = ['#FF5B4D', '#FF9F43', '#FFD93D', '#3ED598', '#4FC3F7', '#7C6BFF', '#FF5CA8', '#FFFFFF'] as const
const COLOR_NAMES = ['红', '橙', '黄', '绿', '青', '紫', '品红', '白'] as const

/** '#RRGGBB' → 'rgba(r,g,b,a)'。 */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const CSS = [
  '.ssd3ov{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.98);display:flex;align-items:center;justify-content:center;cursor:crosshair;user-select:none}',
  '.ssd3ov-wrap{position:relative;display:flex;align-items:center;justify-content:center}',
  '.ssd3ov-frame{display:block;pointer-events:none}',
  '.ssd3ov-dim{position:absolute;inset:0;background:rgba(0,0,0,.42);pointer-events:none}',
  '.ssd3ov-sel{position:absolute;border:1px solid #4FC3F7;background:rgba(79,195,247,.08);box-shadow:0 0 0 100000px rgba(0,0,0,.42);pointer-events:none;display:none}',
  '.ssd3ov-sel::before,.ssd3ov-sel::after{content:"";position:absolute;width:14px;height:14px;border-color:#4FC3F7;border-style:solid}',
  '.ssd3ov-sel::before{left:-1px;top:-1px;border-width:3px 0 0 3px}',
  '.ssd3ov-sel::after{right:-1px;bottom:-1px;border-width:0 3px 3px 0}',
  '.ssd3ov-size{position:absolute;right:6px;bottom:6px;padding:2px 8px;border-radius:4px;background:rgba(10,14,20,.85);color:#E1F5FE;font:12px/1.6 "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;pointer-events:none;display:none}',
  '.ssd3ov-tip{position:fixed;top:24px;left:50%;transform:translateX(-50%);padding:8px 20px;border-radius:18px;background:rgba(10,14,20,.78);color:#E1F5FE;font:13px/1.6 "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;pointer-events:none;white-space:nowrap;z-index:1}',
  '.ssd3ov-tip em{font-style:normal;color:#4FC3F7}',
  '.ssd3ov-tip em.red{color:#FF5B4D}',
  '.ssd3ov-toolbar{position:absolute;display:none;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;background:rgba(26,32,42,.94);box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:2}',
  '.ssd3ov-tool{display:grid;place-items:center;width:30px;height:30px;border:none;border-radius:7px;background:transparent;color:#C7D3E3;cursor:pointer}',
  '.ssd3ov-tool:hover{background:rgba(255,255,255,.12);color:#fff}',
  '.ssd3ov-tool-active{background:#2E6BE6;color:#fff}',
  '.ssd3ov-tool-active:hover{background:#2E6BE6;color:#fff}',
  '.ssd3ov-tool-text{width:auto;padding:0 12px;font:13px/1.6 "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif}',
  '.ssd3ov-sep{width:1px;height:20px;background:rgba(255,255,255,.18)}',
  '.ssd3ov-done{padding:5px 16px;border:none;border-radius:14px;background:#2E6BE6;color:#fff;font:13px/1.6 "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;cursor:pointer}',
  '.ssd3ov-done:hover{background:#3B78F5}',
  // 色板：圆点 + 选中描边环。
  '.ssd3ov-swatch{width:16px;height:16px;flex:none;border:none;border-radius:50%;cursor:pointer;padding:0;box-shadow:0 0 0 2px rgba(255,255,255,0)}',
  '.ssd3ov-swatch.on{box-shadow:0 0 0 2px rgba(255,255,255,.85)}',
  '.ssd3ov-text-input{position:absolute;border:1px solid #4FC3F7;background:rgba(10,14,20,.82);color:#fff;font:15px/1.4 "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;padding:2px 6px;border-radius:4px;outline:none;min-width:40px;z-index:3}',
  '.ssd3ov-text-input::placeholder{color:rgba(255,255,255,.45)}',
].join('\n')

const STYLE_ID = '@max-null/dsh-capture/overlay.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-capture'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

function norm(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

/** 红框与选区的交集（无交集返回 null——红框不允许超出蓝框选区）。 */
function clampToSel(r: Rect, sel: Rect): Rect | null {
  const x1 = Math.max(r.x, sel.x)
  const y1 = Math.max(r.y, sel.y)
  const x2 = Math.min(r.x + r.w, sel.x + sel.w)
  const y2 = Math.min(r.y + r.h, sel.y + sel.h)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** 把点吸附进选区（画框起点在选区外时贴到就近边界）。 */
function clampPoint(p: Point, sel: Rect): Point {
  return {
    x: Math.min(Math.max(p.x, sel.x), sel.x + sel.w),
    y: Math.min(Math.max(p.y, sel.y), sel.y + sel.h),
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('frame decode failed'))
    image.src = src
  })
}

function fitSize(w: number, h: number): { w: number, h: number } {
  const availW = window.innerWidth * 0.96
  const availH = window.innerHeight * 0.94
  const scale = Math.min(availW / w, availH / h, 1)
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

const ICON_BOX = 'M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm1.2.8v7.4c0 .17.13.3.3.3h7.4c.17 0 .3-.13.3-.3V4.3c0-.17-.13-.3-.3-.3H3.5c-.17 0-.3.13-.3.3Z'
const ICON_UNDO = 'M6.7 3.2 3.2 6.7l3.5 3.5M3.6 6.7h6.1a3.1 3.1 0 0 1 0 6.2H8.3'
const ICON_REDO_SEL = 'M3 5.5A2.5 2.5 0 0 1 5.5 3h5A2.5 2.5 0 0 1 13 5.5v5a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 3 10.5v-5Z'
/** 箭头：主线段 + 两翼（指向右上）。 */
const ICON_ARROW = 'M13.2 2.8 4.9 11.1M13.2 2.8v4.6M13.2 2.8H8.6'

function icon(iconPath: string, color: string, flip = false): ReactNode {
  // color='none' = 线条图标:currentColor 描边、不填充(按钮 color 经 CSS 提供);
  // 否则为填充图标(color 直接作 fill)。修复:此前 none 分支把 stroke 也设成
  // none,箭头/撤销线条图标全不可见(2026-08-25 预览编辑浮层实测)。
  return createElement('svg', {
    viewBox: '0 0 16 16', width: '15', height: '15', fill: 'none', 'aria-hidden': true,
    style: flip ? { transform: 'scaleX(-1)' } : undefined,
  }, createElement('path', {
    d: iconPath,
    stroke: color === 'none' ? 'currentColor' : 'none',
    fill: color === 'none' ? 'none' : color,
    strokeWidth: '1.4',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/** 浏览器截图遮罩：框选 + 单阶段红框标注 + 交付（immediate=整图编辑模式）。 */
export function CaptureOverlay(props: CaptureOverlayProps): ReactNode {
  const { dataUrl, width, height, immediate = false, onDone, onCancel } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const annoRef = useRef<HTMLCanvasElement | null>(null)

  // immediate：整图为选区，进入即 tool 阶段（原图预览「编辑」入口）。
  const [phase, setPhase] = useState<'select' | 'tool'>(immediate ? 'tool' : 'select')
  const [showSize, setShowSize] = useState<{ w: number, h: number } | null>(null)
  const [sel, setSel] = useState<Rect | null>(immediate ? { x: 0, y: 0, w: width, h: height } : null)
  const [annoRects, setAnnoRects] = useState<Anno[]>([])
  const [annoDraft, setAnnoDraft] = useState<Anno | null>(null)
  const [toolKind, setToolKind] = useState<AnnoKind>('rect')
  const [annoColor, setAnnoColor] = useState<string>(ANNO_COLORS[0])
  /** 文字工具进行中的输入（物理锚点 + 草稿值）；提交后并入 annoRects。 */
  const [textEdit, setTextEdit] = useState<{ x: number, y: number, value: string } | null>(null)
  const textEditRef = useRef(textEdit)
  textEditRef.current = textEdit

  const live = useRef({ phase, sel, annoRects, annoDraft, showSize, toolKind, annoColor })
  live.current = { phase, sel, annoRects, annoDraft, showSize, toolKind, annoColor }
  const dragStart = useRef<{ phys: Point | null, moved: boolean } | null>(null)
  const annoStart = useRef<Point | null>(null)

  const toPhys = useCallback((clientX: number, clientY: number): Point | null => {
    const wrap = wrapRef.current
    if (wrap === null) return null
    const r = wrap.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return {
      x: ((clientX - r.left) / r.width) * width,
      y: ((clientY - r.top) / r.height) * height,
    }
  }, [width, height])

  /** 合成箭头（含头翼）的共用绘制：坐标为画布内坐标。 */
  const drawArrowPath = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const head = 12
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
    ctx.stroke()
  }

  /** 合成文字标注：标注色文字 + 细黑描边（无背景块；描边保证任意底色可读）。 */
  const drawTextAnno = (ctx: CanvasRenderingContext2D, an: Anno, ox: number, oy: number): void => {
    const x = an.x - ox
    const y = an.y - oy
    ctx.font = '16px "Microsoft YaHei UI", "PingFang SC", sans-serif'
    ctx.textBaseline = 'top'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0, 0, 0, .55)'
    ctx.strokeText(an.text ?? '', x, y)
    ctx.fillStyle = an.color
    ctx.fillText(an.text ?? '', x, y)
  }

  const finish = useCallback(async (): Promise<void> => {
    const s = live.current
    if (s.sel === null || s.sel.w < 2 || s.sel.h < 2) return
    const image = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(s.sel.w)
    canvas.height = Math.round(s.sel.h)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, s.sel.x, s.sel.y, s.sel.w, s.sel.h, 0, 0, canvas.width, canvas.height)
    const source = canvas.toDataURL('image/png')
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, canvas.width, canvas.height)
    ctx.clip()
    for (const r of s.annoRects) {
      ctx.strokeStyle = r.color
      ctx.lineWidth = 3
      ctx.fillStyle = hexToRgba(r.color, 0.12)
      if (r.kind === 'text') {
        drawTextAnno(ctx, r, s.sel.x, s.sel.y)
        continue
      }
      const x = r.x - s.sel.x
      const y = r.y - s.sel.y
      if (r.kind === 'arrow') {
        drawArrowPath(ctx, x, y, x + r.w, y + r.h)
      } else if (r.kind === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(x + r.w / 2, y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fill()
      } else {
        ctx.strokeRect(x, y, r.w, r.h)
        ctx.fillRect(x, y, r.w, r.h)
      }
    }
    ctx.restore()
    onDone(s.annoRects.length > 0
      ? { source, annotated: canvas.toDataURL('image/png') }
      : { source })
  }, [dataUrl, width, height, onDone])

  const backToSelect = useCallback((): void => {
    // 整图编辑（immediate）没有「重新选择」概念：回退到底 = 放弃编辑退出。
    if (immediate) {
      onCancel()
      return
    }
    setPhase('select')
    setSel(null)
    setAnnoRects([])
    setAnnoDraft(null)
    setToolKind('rect')
  }, [immediate, onCancel])

  const cancelOrBack = useCallback((): void => {
    const s = live.current
    if (s.phase === 'tool') {
      if (s.annoDraft !== null) setAnnoDraft(null)
      else if (s.annoRects.length > 0) setAnnoRects(s.annoRects.slice(0, -1))
      else backToSelect()
      return
    }
    onCancel()
  }, [backToSelect, onCancel])

  const enterTool = useCallback((): void => {
    setPhase('tool')
    setAnnoRects([])
    setAnnoDraft(null)
    setToolKind('rect')
  }, [])

  /** 提交进行中的文字输入（空值丢弃锚点）；供 input/画布点击共用。 */
  const commitText = useCallback((text: string): void => {
    const e = textEditRef.current
    if (e === null) return
    const clean = text.trim()
    if (clean !== '') {
      const d: Anno = { kind: 'text', x: e.x, y: e.y, w: 0, h: 0, color: live.current.annoColor, text: clean }
      setAnnoRects([...live.current.annoRects, d])
    }
    setTextEdit(null)
  }, [])

  // ---- 全局事件（挂载时绑定一次） ----
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      // 工具条按钮上的按下不触发任何绘制/选择（点击按钮不应被误认为画框）。
      const toolbarEl = document.querySelector('.ssd3ov-toolbar')
      if (toolbarEl !== null && toolbarEl.contains(event.target as Node)) return
      // 文字输入框内的交互交给 input 自身（提交/取消走它的键盘事件）。
      if (event.target instanceof HTMLInputElement && event.target.classList.contains('ssd3ov-text-input')) return
      // 右键 = 逐级回退（画框中 → 撤框 → 重选 → 取消）。
      if (event.button === 2) {
        event.preventDefault()
        cancelOrBack()
        return
      }
      if (event.button !== 0) return
      const s = live.current
      if (s.phase === 'tool' && s.sel !== null) {
        const p = toPhys(event.clientX, event.clientY)
        if (p === null) return
        if (s.toolKind === 'text') {
          // 文字工具：单击放置锚点并开始输入（无拖拽语义）；已有输入先提交。
          // preventDefault：mousedown 默认焦点转移会抢走输入框焦点
          // （浮层版实测 blur → 空提交 → 输入框关闭）。
          if (textEditRef.current !== null) commitText(textEditRef.current.value)
          event.preventDefault()
          const anchor = clampPoint(p, s.sel)
          setTextEdit({ x: anchor.x, y: anchor.y, value: '' })
          return
        }
        annoStart.current = clampPoint(p, s.sel)
        setAnnoDraft({ x: annoStart.current.x, y: annoStart.current.y, w: 0, h: 0, kind: s.toolKind, color: s.annoColor })
        return
      }
      const p = toPhys(event.clientX, event.clientY)
      dragStart.current = { phys: p, moved: false }
    }
    const onMouseMove = (event: MouseEvent): void => {
      const s = live.current
      if (s.phase === 'tool' && s.sel !== null) {
        if (annoStart.current !== null) {
          const p = toPhys(event.clientX, event.clientY)
          if (p === null) return
          // 箭头保留方向（首尾都 clamp 进选区）；框走交集裁剪（拖出选区消失）。
          if (s.toolKind === 'arrow') {
            const a = clampPoint(annoStart.current, s.sel)
            const b = clampPoint(p, s.sel)
            setAnnoDraft({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, kind: 'arrow', color: s.annoColor })
          } else {
            // 标注框与蓝框实时取交集。拖出选区时预览消失、拖回来立即恢复——
            // 以「画框起点存在」为条件，不能以 annoDraft 为条件（clamp 置 null
            // 后拖回选区就不会再出现）。
            const clipped = clampToSel(norm(annoStart.current.x, annoStart.current.y, p.x, p.y), s.sel)
            setAnnoDraft(clipped === null ? null : { ...clipped, kind: s.toolKind, color: s.annoColor })
          }
        }
        return
      }
      const drag = dragStart.current
      if (drag !== null && drag.phys !== null) {
        const p = toPhys(event.clientX, event.clientY)
        if (p === null) return
        if (!drag.moved && Math.hypot(p.x - drag.phys.x, p.y - drag.phys.y) > 4) {
          drag.moved = true
          setSel(null)
        }
        if (drag.moved) setSel(norm(drag.phys.x, drag.phys.y, p.x, p.y))
      }
    }
    const onMouseUp = (): void => {
      const drag = dragStart.current
      const s = live.current
      if (s.phase === 'tool') {
        if (s.annoDraft !== null) {
          const d = s.annoDraft
          const ok = d.kind === 'arrow'
            ? Math.hypot(d.w, d.h) >= 8
            : d.kind !== 'text' && d.w >= 3 && d.h >= 3
          if (ok) setAnnoRects([...s.annoRects, d])
        }
        setAnnoDraft(null)
        annoStart.current = null
        return
      }
      if (drag === null) return
      const justDragged = drag.moved
      dragStart.current = null
      if (justDragged && s.sel !== null && s.sel.w >= 4 && s.sel.h >= 4) enterTool()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // 文字输入框的按键由 input 自己处理（提交/取消）；这里拦下按键的本体，
      // 否则 Enter/字符会冒泡到 window（React 合成事件 stopPropagation 不
      // 阻断 window 原生监听——实测：文字回车立刻触发 finish，2026-08-24）。
      if (event.target instanceof HTMLInputElement && event.target.classList.contains('ssd3ov-text-input')) return
      const editing = textEditRef.current
      if (editing !== null) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setTextEdit(null)
        }
        return
      }
      if (event.key === 'Escape') cancelOrBack()
      else if (event.key === 'Enter' && live.current.phase === 'tool') void finish().catch(() => {})
    }
    const onDblClick = (): void => {
      const s = live.current
      if (s.phase === 'tool') void finish().catch(() => {})
      else if (s.sel !== null && s.sel.w >= 4 && s.sel.h >= 4) enterTool()
    }
    const onContextMenu = (event: Event): void => event.preventDefault()

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('dblclick', onDblClick)
    document.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('dblclick', onDblClick)
      document.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [cancelOrBack, commitText, enterTool, finish, toPhys])

  // ---- 帧显示尺寸（首次渲染后测量） ----
  useEffect(() => {
    let cancelled = false
    void loadImage(dataUrl).then((image) => {
      if (!cancelled) setShowSize(fitSize(image.naturalWidth, image.naturalHeight))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [dataUrl])

  // ---- 标注 canvas 重绘（tool 阶段） ----
  useEffect(() => {
    const canvas = annoRef.current
    if (canvas === null || phase !== 'tool' || showSize === null) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const sx = showSize.w / width
    const sy = showSize.h / height
    const draw = (r: Anno): void => {
      ctx.strokeStyle = r.color
      ctx.fillStyle = hexToRgba(r.color, 0.12)
      ctx.lineWidth = 2.5
      if (r.kind === 'text') {
        ctx.font = '15px "Microsoft YaHei UI", "PingFang SC", sans-serif'
        ctx.textBaseline = 'top'
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(0, 0, 0, .55)'
        ctx.strokeText(r.text ?? '', r.x * sx, r.y * sy)
        ctx.fillStyle = r.color
        ctx.fillText(r.text ?? '', r.x * sx, r.y * sy)
        return
      }
      const x = r.x * sx
      const y = r.y * sy
      const w = r.w * sx
      const h = r.h * sy
      if (r.kind === 'arrow') {
        drawArrowPath(ctx, x, y, x + w, y + h)
        return
      }
      if (r.kind === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fill()
        return
      }
      ctx.strokeRect(x, y, w, h)
      ctx.fillRect(x, y, w, h)
    }
    for (const r of annoRects) draw(r)
    if (annoDraft !== null) draw(annoDraft)
  }, [phase, showSize, width, height, annoRects, annoDraft])

  if (showSize === null) {
    return createPortal(createElement('div', { className: 'ssd3ov' }), document.body)
  }

  const s = live.current
  const sx = showSize.w / width
  const sy = showSize.h / height
  const selDisplay = s.sel === null ? null : {
    x: s.sel.x * sx, y: s.sel.y * sy, w: s.sel.w * sx, h: s.sel.h * sy,
  }
  const toolbar = selDisplay !== null && selDisplay.w > 1 && selDisplay.h > 1
    ? createElement('div', {
        key: 'toolbar', className: 'ssd3ov-toolbar',
        style: {
          display: 'flex',
          left: Math.max(170, Math.min(showSize.w - 170, selDisplay.x + selDisplay.w / 2)),
          transform: 'translateX(-50%)',
          top: selDisplay.y + selDisplay.h + 8 <= showSize.h - 48
            ? selDisplay.y + selDisplay.h + 8
            : Math.max(4, selDisplay.y - 48),
        },
      }, [
        createElement('button', {
          key: 'box', type: 'button', className: `ssd3ov-tool${toolKind === 'rect' ? ' ssd3ov-tool-active' : ''}`, title: '矩形框',
          onClick: () => setToolKind('rect'),
        }, icon(ICON_BOX, '#FF5B4D')),
        createElement('button', {
          key: 'ellipse', type: 'button', className: `ssd3ov-tool${toolKind === 'ellipse' ? ' ssd3ov-tool-active' : ''}`, title: '椭圆框',
          onClick: () => setToolKind('ellipse'),
        }, createElement('svg', {
          viewBox: '0 0 16 16', width: '15', height: '15', fill: 'none', 'aria-hidden': true,
        }, createElement('circle', { cx: '8', cy: '8', r: '5.6', stroke: '#FF5B4D', strokeWidth: '1.8' }))),
        createElement('button', {
          key: 'arrow', type: 'button', className: `ssd3ov-tool${toolKind === 'arrow' ? ' ssd3ov-tool-active' : ''}`, title: '箭头（指向要改的内容）',
          onClick: () => setToolKind('arrow'),
        }, icon(ICON_ARROW, 'none')),
        createElement('button', {
          key: 'text', type: 'button', className: `ssd3ov-tool${toolKind === 'text' ? ' ssd3ov-tool-active' : ''}`, title: '文字（点一下输入描述）',
          onClick: () => setToolKind('text'),
        }, 'T'),
        createElement('div', { key: 'sep1', className: 'ssd3ov-sep' }),
        ...ANNO_COLORS.map((color, i) => createElement('button', {
          key: `swatch-${color}`, type: 'button',
          className: `ssd3ov-swatch${annoColor === color ? ' on' : ''}`,
          title: COLOR_NAMES[i],
          style: { background: color },
          onClick: () => setAnnoColor(color),
        })),
        createElement('div', { key: 'sep2', className: 'ssd3ov-sep' }),
        createElement('button', {
          key: 'undo', type: 'button', className: 'ssd3ov-tool', title: '撤销（上一标注）',
          onClick: () => {
            if (s.annoRects.length > 0) setAnnoRects(s.annoRects.slice(0, -1))
          },
        }, icon(ICON_UNDO, 'none')),
        createElement('button', {
          key: 'reselect', type: 'button', className: 'ssd3ov-tool ssd3ov-tool-text', title: '取消（清除标注并重新选择）',
          onClick: backToSelect,
        }, '取消'),
        createElement('button', {
          key: 'done', type: 'button', className: 'ssd3ov-done',
          onClick: () => { void finish().catch(() => {}) },
        }, '完成'),
      ])
    : null

  const tip = s.phase === 'select'
    ? createElement('div', { className: 'ssd3ov-tip' },
        createElement('em', null, '拖拽 '), '选择截图区域 · ',
        createElement('em', null, '右键 / Esc'), ' 取消')
    : createElement('div', { className: 'ssd3ov-tip' },
        '拖拽画', createElement('em', { className: 'red' }, '标注 '), '· ', createElement('em', null, 'T'), ' 点一下写文字 · ',
        createElement('em', null, '回车'), ' 完成 · ',
        createElement('em', null, '右键 / Esc'), ' 逐级回退')

  return createPortal(
    createElement('div', { className: 'ssd3ov' }, [
      createElement('div', {
        key: 'wrap', className: 'ssd3ov-wrap', ref: wrapRef,
        style: { width: showSize.w, height: showSize.h },
      }, [
        createElement('img', {
          key: 'frame', className: 'ssd3ov-frame',
          src: dataUrl, alt: '',
          style: { width: showSize.w, height: showSize.h },
        }),
        s.phase === 'select' ? createElement('div', { key: 'dim', className: 'ssd3ov-dim' }) : null,
        !immediate && selDisplay !== null && selDisplay.w > 1 && selDisplay.h > 1
          ? createElement('div', {
              key: 'sel', className: 'ssd3ov-sel',
              style: {
                display: 'block',
                left: selDisplay.x, top: selDisplay.y,
                width: selDisplay.w, height: selDisplay.h,
              },
            })
          : null,
        !immediate && selDisplay !== null && selDisplay.w > 1 && selDisplay.h > 1
          ? createElement('div', {
              key: 'size', className: 'ssd3ov-size',
              style: { display: 'block' },
            }, `${Math.round(s.sel!.w)} × ${Math.round(s.sel!.h)}`)
          : null,
        createElement('canvas', {
          key: 'anno', ref: annoRef,
          width: showSize.w, height: showSize.h,
          style: { position: 'absolute', inset: 0, pointerEvents: 'none' },
        }),
        textEdit !== null
          ? createElement('input', {
              key: 'text-input', className: 'ssd3ov-text-input', type: 'text',
              style: { left: textEdit.x * sx, top: textEdit.y * sy },
              value: textEdit.value,
              placeholder: '输入文字…',
              autoFocus: true,
              onChange: (e: { target: { value: string } }) => setTextEdit({ ...textEdit, value: e.target.value }),
              onKeyDown: (e: { key: string, stopPropagation: () => void, nativeEvent: Event }) => {
                if (e.key === 'Enter') commitText(textEdit.value)
                else if (e.key === 'Escape') setTextEdit(null)
                // React 合成 stopPropagation 不阻断 window 原生监听（实测），
                // 显式拦下原生链，避免文字回车触发 finish。
                if (typeof e.nativeEvent.stopPropagation === 'function') e.nativeEvent.stopPropagation()
                else e.stopPropagation()
              },
              onBlur: () => commitText(textEdit.value),
            })
          : null,
        toolbar,
      ]),
      tip,
    ]),
    document.body,
  )
}
