/**
 * @max-null/dsh-capture — host half.
 *
 * 三层职责：
 *  ① `/api/ssid/screenshot/*` 路由（carrier-neutral：走 `ctx.connection.fetch`
 *     的精确路由表，Web 载体与 Electron shell 载体都分发同一个 handler）：
 *     设置页读写 ~/.ssid/screenshot.json（hideWindow 截图时是否隐藏主窗口、
 *     hotkey 全局快捷键），客户端按钮走 trigger 触发截图。
 *  ② 经服务键 `ssid.shell.screenshot`（由壳的 desktop-host 半 `ctx.provide`
 *     注入，见思灵仓库 `ssid-desktop/apps/desktop-host/src/ssid-screenshot.ts`）
 *     调用壳层能力：trigger 开浮层、apply 重注册快捷键。手动 dsh web
 *     （无 Electron 壳）时服务不存在：get 返回 shellAvailable=false，
 *     set 仅写配置文件（壳内下次启动生效），trigger 返回 503。
 *  ③ client 半完成投递：监听 `ssid:screenshot` CustomEvent → 官方 drop
 *     intake 填入当前会话输入框草稿。
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: pulls the connection Context augmentation (ctx.connection).
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin identity for cordis.yml rows. */
export const name = '@max-null/dsh-capture'

/** 设置 namespace（设置——插件页卡片锚点；与 client settingsScope.bind 一致）。 */
export const CAPTURE_NS = 'dsh-capture'

/** 设置 schema（隐藏窗口 + 全局快捷键；存储仍走 screenshot.json——主进程壳层消费）。
 *
 *  0.1.7 起插件的 Config schema 本身就构成它的 settings section（不再有
 *  `installSection`），**可变字段必须标 `.volatile()`**——`settings/src/schema.ts`
 *  的 `isVolatilePath` 只承认「祖先节点标了 volatile」的路径，非 volatile 路径在
 *  `settings/src/index.ts:406` 直接抛错；漏标则本插件的 namespace 不被 Host serve，
 *  设置卡整区不渲染（2026-09-26 实测）。见官方范例 `web-search-deepseek/src/index.ts`
 *  与我们的 `dsh-node-appearance`。
 *
 *  不写 `z<Config>` 显式泛型：`.volatile()` 会把字段的 schema Mode 变成
 *  `'volatile-defined'`，与接口里声明的 `Volatile<T>` 不是同一个 Mode，显式泛型会报类型不匹配。 */
export const Config = z.object({
  hideWindow: z.boolean().default(true).volatile(),
  hotkey: z.string().default('Control+Shift+A').volatile(),
})

/** 设置值形状（与 {@link Config} 的 schema 对齐）。 */
export interface CaptureConfig {
  hideWindow: Volatile<boolean>
  hotkey: Volatile<string>
}

/**
 * Services required before mounting: the shared Fetch route registry.
 *
 * `ctx.connection` is carrier-neutral: the Web app owns its `/api` HTTP bridge,
 * while a shell-owned carrier (Electron) dispatches the same handler over its
 * own transport. Trust and browser authentication are applied by the carrier
 * before this handler runs, so the plugin no longer carries a Host/Origin fence.
 */
export const inject = ['connection']

/** 配置文件路径（与壳层 `ssid-desktop/apps/desktop/src/ssid/screenshot.ts` 同源；
 *  该处的 `SSID_SCREENSHOT_CONFIG` 可整体覆盖，供隔离实例用独立配置）。 */
const CONFIG_PATH = join(homedir(), '.ssid', 'screenshot.json')
const CONFIG_DEFAULTS = { hideWindow: true, hotkey: 'Control+Shift+A' }

/** 服务键（与壳层 `ssid-desktop/apps/desktop-host/src/ssid-screenshot.ts` 的 SSID_SHELL_SCREENSHOT_KEY 一致）。 */
const SHELL_SCREENSHOT_KEY = 'ssid.shell.screenshot'

/** 路由基址（必须在 `/api` 之下：共享通道只分发该前缀）。 */
const ROUTE_BASE = '/api/ssid/screenshot'

/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20

/** 读取配置（损坏/缺失 → 默认值）。 */
function readConfig(): { hideWindow: boolean, hotkey: string } {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { hideWindow?: unknown, hotkey?: unknown } | null
    return {
      hideWindow: parsed?.hideWindow !== false,
      hotkey: typeof parsed?.hotkey === 'string' && parsed.hotkey.trim() !== '' ? parsed.hotkey : CONFIG_DEFAULTS.hotkey,
    }
  } catch {
    return { ...CONFIG_DEFAULTS }
  }
}

/** 写入配置（目录不存在则创建）。 */
function writeConfig(next: { hideWindow: boolean, hotkey: string }): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n')
}

/** 是否运行在 SSiD 壳内（Electron 主进程注入过截图能力）。 */
function shellScreenshot(ctx: Context): { trigger: () => void, apply: () => boolean } | undefined {
  return ctx.get(SHELL_SCREENSHOT_KEY) as { trigger: () => void, apply: () => boolean } | undefined
}

// ---- 路由基础设施 ----

/** One API failure with its wire code and HTTP status. */
class ScreenshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ScreenshotError'
  }
}

/** JSON response helper (Fetch API shape, no node:http objects). */
function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** 把任意异常转成响应体（保留 wire code 与状态码）。 */
function errorResponse(error: unknown): Response {
  if (error instanceof ScreenshotError) {
    return jsonResponse(error.status, { ok: false, error: { code: error.code, message: error.message } })
  }
  return jsonResponse(500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
}

/** 读取 JSON body（空 body → {}；超限/非法 → ScreenshotError）。 */
async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new ScreenshotError('bad-request', 'request body too large')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ScreenshotError('bad-request', 'request body is not valid JSON')
  }
}

/** 单条路由的业务处理（方法名即路由尾段）。 */
async function handle(method: 'get' | 'set' | 'trigger', ctx: Context, payload: unknown): Promise<unknown> {
  if (method === 'get') {
    return {
      ...readConfig(),
      shellAvailable: shellScreenshot(ctx) !== undefined,
    }
  }
  if (method === 'set') {
    const record = payload as { hideWindow?: unknown, hotkey?: unknown } | null
    const config = readConfig()
    if (typeof record?.hideWindow === 'boolean') config.hideWindow = record.hideWindow
    if (typeof record?.hotkey === 'string' && record.hotkey.trim() !== '') config.hotkey = record.hotkey.trim()
    writeConfig(config)
    // 壳内即时重注册快捷键（手动 dsh web 无服务：仅配置文件生效）。
    const applied = shellScreenshot(ctx)?.apply?.() ?? false
    return { ...config, appliedHotkey: applied === true }
  }
  const shell = shellScreenshot(ctx)
  if (shell === undefined) {
    throw new ScreenshotError('shell-unavailable', 'screenshot capture is only available inside the SSiD desktop shell', 503)
  }
  shell.trigger()
  return { ok: true }
}

/**
 * Plugin body: register the three exact `/api/ssid/screenshot/*` routes.
 * @param ctx - host plugin context (connection).
 */
export function apply(ctx: Context): void {
  for (const method of ['get', 'set', 'trigger'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE_BASE}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const payload = await readJsonBody(request)
          return jsonResponse(200, { ok: true, value: await handle(method, ctx, payload) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    }), `@max-null/dsh-capture: ${ROUTE_BASE}/${method}`)
  }

  // 设置页卡片：不再经 `settings.installSection` 声明 namespace。
  // 该方法在 DSH 0.1.7 的 Settings 服务上已不存在（现在的公开面只有
  // configure / describe / update / replace / mutate），调用会抛 TypeError；
  // 而且本插件的配置真身在 `~/.ssid/screenshot.json`（主进程壳层热键消费），
  // 走 settings 表单会造成两层存储分叉——所以它本来也**不该**进设置表单。
  // 卡片改由 client 半注册到 `plugins.bundle.config`（见 src/client/index.ts）。
}
