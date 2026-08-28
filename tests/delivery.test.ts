import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * 截图投递防抖回归(2026-08-24 双发 bug):
 * 同内容 800ms 内重复投递必须被丢弃——任何新监听器/热重载路径残留都不允许双发。
 * 每次用例动态 import 模块,重置模块级防抖状态(隔离)。
 */
async function loadDelivery() {
  vi.resetModules()
  return await import('../src/client/delivery.ts')
}

function installDomStubs() {
  const dispatchCalls: Array<{ type: string; dataTransfer: unknown }> = []
  const addedFiles: Array<{ name: string; size: number }> = []

  class FakeDataTransfer {
    items = {
      add(file: unknown) {
        addedFiles.push({ name: (file as File).name, size: (file as File).size })
      },
    }
    types = ['Files']
  }

  class FakeDragEvent {
    type: string
    dataTransfer: unknown
    constructor(type: string, init: { dataTransfer?: unknown }) {
      this.type = type
      this.dataTransfer = init.dataTransfer
    }
  }

  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('DragEvent', FakeDragEvent)
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['fake-png'], { type: 'image/png' }) })))

  // document.dispatchEvent 由 jsdom 提供;spy 记录真实调用。
  const spy = vi.spyOn(document, 'dispatchEvent')
  spy.mockImplementation((e) => {
    const ev = e as unknown as FakeDragEvent
    dispatchCalls.push({ type: ev.type, dataTransfer: ev.dataTransfer })
    return true
  })
  return { dispatchCalls, addedFiles, spy }
}

describe('delivery(截图投递)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('isImageDataUrl:只认 data:image/ 前缀', async () => {
    const { isImageDataUrl } = await loadDelivery()
    expect(isImageDataUrl('data:image/png;base64,xx')).toBe(true)
    expect(isImageDataUrl('data:image/jpeg;base64,xx')).toBe(true)
    expect(isImageDataUrl('https://x/y.png')).toBe(false)
    expect(isImageDataUrl('data:text/plain,hi')).toBe(false)
    expect(isImageDataUrl(123)).toBe(false)
  })

  it('投递一次 → drop 事件带 File,文件大小正确', async () => {
    const { deliverToComposer } = await loadDelivery()
    const { dispatchCalls, addedFiles } = installDomStubs()
    await deliverToComposer('data:image/png;base64,AAAA', 'ssid-screenshot-source.png')
    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0]?.type).toBe('drop')
    expect(addedFiles[0]?.name).toBe('ssid-screenshot-source.png')
  })

  it('回归:同内容 800ms 内第二次投递被丢弃(防抖,不双发)', async () => {
    const { deliverToComposer } = await loadDelivery()
    const { dispatchCalls } = installDomStubs()
    const dataUrl = 'data:image/png;base64,same-content'
    await deliverToComposer(dataUrl)
    await deliverToComposer(dataUrl)
    expect(dispatchCalls).toHaveLength(1)
  })

  it('不同内容 → 正常再次投递(防抖不误伤)', async () => {
    const { deliverToComposer } = await loadDelivery()
    const { dispatchCalls } = installDomStubs()
    await deliverToComposer('data:image/png;base64,AAA')
    await deliverToComposer('data:image/png;base64,BBB')
    expect(dispatchCalls).toHaveLength(2)
  })
})
