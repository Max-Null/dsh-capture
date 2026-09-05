/**
 * @max-null/dsh-capture — browser half.
 *
 * 三层职责：
 *  1. 投递（壳层 → 输入框）：监听 `ssid:screenshot` CustomEvent（detail =
 *     裁剪结果 `data:image/png;base64,…`，由 shell/main.mjs 经
 *     mainView.webContents.executeJavaScript 派发），把 PNG 送进当前会话
 *     输入框草稿——合成 drop 走 DSH 官方 composer 图片 intake
 *     （ui-attachment 的 document 级 drop 处理器，只认
 *     `dataTransfer.types.includes('Files')`，量/类型/大小限制与真实拖拽一致）。
 *  2. 截图按钮：注册 `conversation.input.right`（润色按钮同一座位），点击
 *     调 /ssid/api/screenshot/trigger 让壳层开浮层。
 *  3. 设置：注册「设置——插件」页卡片（settings.plugin.item）：隐藏窗口开关
 *     + 全局快捷键编辑，即改即存（2026-09-06 由通用设置两行迁入）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ScreenshotButton } from './ScreenshotButton'
import { ScreenshotSettingsCard } from './ScreenshotSettings'
import { ImagePreviewEditHost } from './ImagePreviewEdit'
import { deliverToComposer, isImageDataUrl } from './delivery'

export const inject = ['slots']

/** 事件名（与 shell/main.mjs 派发一致）。 */
const SCREENSHOT_EVENT = 'ssid:screenshot'

/** 壳层派发协议 v2：{ uid, source, annotated? }。
 *  source = 纯裁剪原图（不遮挡原始内容）；annotated 仅当浮层确已编辑时
 *  携带（无标注不传编辑图，2026-08-24）；uid 由主进程生成，监听侧按 uid
 *  去重。旧版监听器只认字符串 dataURL，收到对象会自然忽略——协议升级
 *  同时根除历史 hmr 残留监听器造成的双发。 */
interface ScreenshotPayload {
  uid: string
  source: string
  annotated?: string
}

function parseShotPayload(detail: unknown): ScreenshotPayload | null {
  if (typeof detail !== 'object' || detail === null) return null
  const p = detail as Record<string, unknown>
  if (typeof p.uid !== 'string' || p.uid === '') return null
  if (typeof p.source !== 'string' || !isImageDataUrl(p.source)) return null
  let annotated: string | undefined
  if (p.annotated !== undefined) {
    if (typeof p.annotated !== 'string' || !isImageDataUrl(p.annotated)) return null
    annotated = p.annotated
  }
  return { uid: p.uid, source: p.source, annotated }
}

/** 已投递 uid 集合：主进程单会话只派发一次，防御性去重；
 *  模块级缓存防止 hmr 后重复投递。 */
const deliveredUids = new Set<string>()

/** Plugin body: register the delivery listener, the composer capture button,
 *  and the two General-settings rows. */
export function apply(ctx: ClientContext): void {
  // 投递监听走 effect（组件重载/卸载时移除）——DSH 通过 client-hmr 热替换
  // 会再次执行 apply（2026-08-24：此前用 window 一次性守卫跳过后半段，
  // 热替换后按钮/设置行永远消失，只剩裸监听）。监听去重由 effect dispose 保证。
  const onScreenshot = (event: Event): void => {
    const payload = parseShotPayload((event as CustomEvent<unknown>).detail)
    if (payload === null) return
    if (deliveredUids.has(payload.uid)) {
      console.warn(`[ssid-screenshot] duplicate uid ${payload.uid} skipped`)
      return
    }
    deliveredUids.add(payload.uid)
    console.info(`[ssid-screenshot] event received uid=${payload.uid} (source ${payload.source.length}, annotated ${payload.annotated?.length ?? 0})`)
    // 原图在前、编辑图在后：帮助理解方在标注遮盖原内容时仍能对照上下文；
    // 无标注（annotated 缺省）只投原图。
    const annotated = payload.annotated
    void deliverToComposer(payload.source, 'ssid-screenshot-source.png')
      .then(() => {
        if (annotated === undefined) return undefined
        return deliverToComposer(annotated, 'ssid-screenshot-annotated.png')
      })
      .catch((error) => {
        console.warn(`[ssid-screenshot] delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  ctx.effect(() => {
    window.addEventListener(SCREENSHOT_EVENT, onScreenshot)
    return () => window.removeEventListener(SCREENSHOT_EVENT, onScreenshot)
  }, 'dsh-capture: screenshot delivery')

  // 常驻「原图预览编辑」宿主：独立 React root（官方 ui-renderer 同款
  // createRoot；无 slot 可挂——预览对话框是官方 body portal 部件，
  // MutationObserver 注入编辑按钮，见 ImagePreviewEdit）。
  const host = document.createElement('div')
  host.dataset.dshImagePreviewEdit = '1'
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(createElement(ImagePreviewEditHost))
  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'dsh-capture: image edit preview host')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'ssid-screenshot',
    order: -10,
  }, ScreenshotButton))

  // 设置进「设置——插件」页：一张卡片（原通用设置两行合并为卡内两行）。
  ctx.slots.inject(('settings.plugin.item') as never, () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-capture',
  } as never, ScreenshotSettingsCard))
}

export { ScreenshotButton, ScreenshotSettingsCard }
