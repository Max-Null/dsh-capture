/**
 * 截图投递：把裁剪结果 PNG 经 DSH 官方 composer 图片 intake 填入输入框草稿。
 * 合成 drop（new DataTransfer + DragEvent）与真实拖拽等价：量/类型/大小限制、
 * 草稿预览、删除、发送序列化全部走官方路径（ui-attachment 的 document 级
 * drop 处理器，只认 `dataTransfer.types.includes('Files')`）。
 */

/** 事件 detail 的最低校验：必须是 image data URL。 */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/')
}

/** data URL → Blob（浏览器自带 fetch 解码，无需手动 base64 解析）。 */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

/** 重复投递防抖：同内容 800ms 内的第二次调用直接丢弃。
 *  背景：client-hmr 热替换前的旧 bundle 曾用一次性 window 守卫注册永不移除的
 *  监听器（2026-08-24 修复），页面未刷新时新旧监听并存 → 一次确认投递两次、
 *  消息区出现两张截图。投递层幂等兜底，任何路径残留监听都不会双发。 */
let lastKey = ''
let lastAt = 0
function isDuplicate(dataUrl: string): boolean {
  const key = `${dataUrl.length}:${dataUrl.slice(0, 64)}`
  const now = Date.now()
  if (key === lastKey && now - lastAt < 800) return true
  lastKey = key
  lastAt = now
  return false
}

/** 一次与真实图片拖拽等价的落放：PNG File 经官方 drop 通道进草稿。 */
export async function deliverToComposer(dataUrl: string): Promise<void> {
  if (isDuplicate(dataUrl)) {
    console.warn('[ssid-screenshot] duplicate delivery skipped')
    return
  }
  const blob = await dataUrlToBlob(dataUrl)
  const file = new File([blob], 'ssid-screenshot.png', { type: 'image/png' })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  console.info(`[ssid-screenshot] drop ${file.size} bytes, types=${transfer.types.join(',')}`)
  document.dispatchEvent(new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  }))
  console.info('[ssid-screenshot] drop dispatched')
}
