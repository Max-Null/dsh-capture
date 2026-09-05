/**
 * ScreenshotSettings: two General-settings rows (settings.general.item —
 * the additive seat for a single setting that needs no page of its own).
 *
 * Rows (each fetched/saved through /ssid/api/screenshot/*):
 *  - screenshot-hide: 截图时是否隐藏思灵窗口（checkbox，切换即保存）
 *  - screenshot-hotkey: 全局快捷键（input，回车/失焦即保存，实时重注册）
 *
 * The General row contract: the section supplies no props at all — copy,
 * current value, and the write path are all the registrant's own.
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { screenshotGet, screenshotSet } from './api'

/** Product copy (zh/en via the document lang). */
const STRINGS: Record<string, Record<string, string>> = {
  zh: {
    cardName: '截图',
    cardDesc: '截图行为设置——隐藏思灵窗口与全局快捷键',
    hideTitle: '截图时隐藏思灵窗口',
    hideDesc: '开：冻结帧不含思灵自身（引用其他应用）；关：冻结帧包含思灵（可框选对话内容）',
    hotkeyTitle: '截图全局快捷键',
    hotkeyDesc: 'Electron accelerator 语法，如 Control+Shift+A；保存后立即生效',
    placeholder: 'Control+Shift+A',
    saved: '✓ 已保存',
    saveFail: '保存失败：',
    hotkeyInvalid: '格式无效，例：Control+Shift+A',
    loadFail: '加载失败',
  },
  en: {
    cardName: 'Capture',
    cardDesc: 'Capture behavior — hide the SSiD window and the global shortcut',
    hideTitle: 'Hide the SSiD window while capturing',
    hideDesc: 'On: frozen frame excludes SSiD (reference other apps); Off: includes SSiD (can box-select conversation content)',
    hotkeyTitle: 'Capture global shortcut',
    hotkeyDesc: 'Electron accelerator syntax, e.g. Control+Shift+A; takes effect immediately',
    placeholder: 'Control+Shift+A',
    saved: '✓ Saved',
    saveFail: 'Save failed: ',
    hotkeyInvalid: 'Invalid format, e.g. Control+Shift+A',
    loadFail: 'Failed to load',
  },
}

function langStrings(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? (document.documentElement.lang || 'zh').toLowerCase() : 'zh'
  return STRINGS[lang.startsWith('zh') ? 'zh' : 'en']
}

/** Row styles — the DSH General-settings row language (title/desc left, control right). */
const CSS = [
  '.ssd3r{display:flex;align-items:center;gap:16px;padding:12px 0}',
  '.ssd3r+.ssd3r{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.ssd3r-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.ssd3r-title{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.ssd3r-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
  '.ssd3r-input{flex:none;width:200px;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.ssd3r-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.ssd3r-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
  '.ssd3r-msg{font-size:12px;line-height:1.5}',
  '.ssd3r-msg[data-ok=true]{color:var(--dsw-alias-state-success-primary)}',
  '.ssd3r-msg[data-ok=false]{color:var(--dsw-alias-state-error-primary)}',
  // 家族开关（dsh-ssid-panels 通知设置同款：40x22 胶囊 + 白色圆钮）。
  '.ssd3r-switch{width:40px;height:22px;flex:none;border:none;border-radius:11px;cursor:pointer;padding:0;background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));transition:background .15s}',
  '.ssd3r-switch.on{background:var(--dsw-alias-state-business-primary,#4FC3F7)}',
  '.ssd3r-switch .knob{display:block;width:16px;height:16px;border-radius:8px;background:#fff;margin-left:2px;transition:margin-left .15s}',
  '.ssd3r-switch.on .knob{margin-left:22px}',
  // 设置——插件页卡片壳（官方 PluginCard chrome 同款 token）。
  '.ssd3Card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
  '.ssd3Card:hover{border-color:var(--dsw-alias-label-dimmed)}',
  '.ssd3CardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.ssd3CardHeader{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
  '.ssd3CardHeadText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.ssd3CardName{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
  '.ssd3CardDesc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
  '.ssd3CardChevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
  '.ssd3CardChevronOn{transform:rotate(180deg)}',
  '.ssd3CardBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
].join('')

const STYLE_ID = '@max-null/dsh-capture/settings.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-capture'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

const HOTKEY_PATTERN = /^[A-Za-z0-9+]+$/

/** One General-row skeleton: title/desc left, control right, transient msg below the title. */
function Row(props: { title: string, desc: string, control: ReactNode, msg: { ok: boolean, text: string } | null }): ReactNode {
  return createElement('div', { className: 'ssd3r' }, [
    createElement('div', { key: 'text', className: 'ssd3r-text' }, [
      createElement('div', { key: 'title', className: 'ssd3r-title' }, props.title),
      createElement('div', { key: 'desc', className: 'ssd3r-desc' }, props.desc),
      props.msg !== null
        ? createElement('div', { key: 'msg', className: 'ssd3r-msg', 'data-ok': props.msg.ok ? 'true' : 'false' }, props.msg.text)
        : null,
    ]),
    props.control,
  ])
}

/** 隐藏窗口开关行：切换即保存；非壳环境（无此能力）整行隐藏。 */
export function ScreenshotHideRow(): ReactNode {
  const t = langStrings()
  const [value, setValue] = useState<boolean | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean, text: string } | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    screenshotGet()
      .then((config) => {
        if (cancelled) return
        if (!config.shellAvailable) {
          setHidden(true)
          return
        }
        setValue(config.hideWindow)
      })
      .catch(() => { if (!cancelled) setMsg({ ok: false, text: t.loadFail }) })
    return () => { cancelled = true }
  }, [t])

  const toggle = useCallback((): void => {
    const next = !value
    setValue(next)
    setMsg(null)
    screenshotSet({ hideWindow: next })
      .then(() => setMsg({ ok: true, text: t.saved }))
      .catch((error: unknown) => {
        setValue(!next)
        setMsg({ ok: false, text: t.saveFail + (error instanceof Error ? error.message : String(error)) })
      })
  }, [value, t])

  if (hidden) return null

  return createElement(Row, {
    title: t.hideTitle,
    desc: t.hideDesc,
    msg,
    control: createElement('button', {
      className: `ssd3r-switch${value === true ? ' on' : ''}`,
      type: 'button',
      disabled: value === null,
      'aria-label': t.hideTitle,
      onClick: toggle,
    }, createElement('span', { className: 'knob' })),
  })
}

/** 全局快捷键行：回车/失焦即保存（延时 300ms 防抖）；非壳环境整行隐藏。 */
export function ScreenshotHotkeyRow(): ReactNode {
  const t = langStrings()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean, text: string } | null>(null)
  const [hidden, setHidden] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    let cancelled = false
    screenshotGet()
      .then((config) => {
        if (cancelled) return
        if (!config.shellAvailable) {
          setHidden(true)
          return
        }
        setValue(config.hotkey)
      })
      .catch(() => { if (!cancelled) setMsg({ ok: false, text: t.loadFail }) })
    return () => { cancelled = true }
  }, [t])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const save = useCallback((raw: string): void => {
    window.clearTimeout(timer.current)
    const hotkey = raw.trim()
    if (hotkey === '') return
    if (!HOTKEY_PATTERN.test(hotkey)) {
      setMsg({ ok: false, text: t.hotkeyInvalid })
      return
    }
    setSaving(true)
    setMsg(null)
    screenshotSet({ hotkey })
      .then(() => { setMsg({ ok: true, text: t.saved }) })
      .catch((error: unknown) => {
        setMsg({ ok: false, text: t.saveFail + (error instanceof Error ? error.message : String(error)) })
      })
      .finally(() => { setSaving(false) })
  }, [t])

  const scheduleSave = useCallback((raw: string): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => save(raw), 300)
  }, [save])

  if (hidden) return null

  return createElement(Row, {
    title: t.hotkeyTitle,
    desc: t.hotkeyDesc,
    msg,
    control: createElement('input', {
      className: 'ssd3r-input',
      type: 'text',
      value,
      placeholder: t.placeholder,
      spellCheck: false,
      disabled: saving,
      onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') save(value) },
      onChange: (e: { target: { value: string } }) => { setValue(e.target.value); setMsg(null) },
      onBlur: () => scheduleSave(value),
    }),
  })
}

/** 设置——插件页卡片：截图行为（隐藏窗口开关 + 全局快捷键）——合并原两行通用设置。 */
export function ScreenshotSettingsCard(): ReactNode {
  const [open, setOpen] = useState(false)
  const t = langStrings()
  return createElement('li', { className: 'ssd3Card' + (open ? ' ssd3CardOpen' : '') },
    createElement('button', {
      type: 'button',
      className: 'ssd3CardHeader',
      'aria-expanded': open,
      onClick: () => setOpen((v: boolean) => !v),
      children: [
        createElement('span', { className: 'ssd3CardHeadText' },
          createElement('span', { className: 'ssd3CardName' }, t.cardName),
          createElement('span', { className: 'ssd3CardDesc' }, t.cardDesc),
        ),
        createElement('svg', {
          className: 'ssd3CardChevron' + (open ? ' ssd3CardChevronOn' : ''),
          viewBox: '0 0 14 14', width: 14, height: 14,
          fill: 'none', 'aria-hidden': true,
        }, createElement('path', {
          d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
          fill: 'currentColor',
        })),
      ],
    }),
    open ? createElement('div', { className: 'ssd3CardBody', children: [
      createElement(ScreenshotHideRow, { key: 'hide' }),
      createElement(ScreenshotHotkeyRow, { key: 'hotkey' }),
    ] }) : null,
  )
}
