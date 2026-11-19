/**
 * 界面半边的离线检查：用桩 `window.__ModuleLoader__` 与桩 React 加载 client.js，
 * 驱动它的 `apply`，断言页签类型、页签主体、词条表与面板各种状态下的渲染。
 *
 * 用法：`node scripts/client-smoke.mjs`（在插件目录里）。
 *
 * 覆盖不到的部分：真实浏览器里的 React 渲染、主题、点击交互与路由往返，
 * 这些只能在刷新后的页面里验证。
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
const checkTrue = (label, value) => {
  if (value !== true) failures.push(`${label}\n  expected: true\n  actual:   ${JSON.stringify(value)}`)
}

let uploaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { uploaded = definition },
  },
}
await import(pathToFileURL(join(import.meta.dirname, '..', 'client.js')).href)

check('module id', uploaded?.id, '@kingzyt/dsh-spur')
checkTrue('module registers a factory', typeof uploaded?.factory === 'function')

/** Render a function component eagerly so the whole tree (not just its props) is inspected. */
const element = (type, props, ...children) => {
  const merged = { ...props, children }
  return typeof type === 'function' ? type(merged) : { type, props: merged }
}

/** React stub whose `useState` hands out the queued values in call order. */
function react(values = []) {
  let index = 0
  return {
    createElement: element,
    useState(initial) {
      const value = index < values.length ? values[index] : initial
      index += 1
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(callback) { return callback },
  }
}

/** Load the module once with a stub context and record what it registers. */
function mount(reactStub) {
  const dictionaries = {}
  const tabTypes = []
  const registrations = []
  const injected = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    locale: {
      register(namespace, table) {
        dictionaries[namespace] = table
        return () => {}
      },
      bind(namespace) {
        return (key) => {
          const table = dictionaries[namespace] ?? {}
          return (table.zh ?? table.en ?? {})[key] ?? key
        }
      },
    },
    slots: {
      inject(name, register) {
        injected.push(name)
        return register()
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
  }
  const client = uploaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected import: ${name}`)
  })
  client.apply(ctx)
  return { client, dictionaries, tabTypes, registrations, injected }
}

// ── 注册面 ───────────────────────────────────────────────────────────────────
const mounted = mount(react())
check('module inject', mounted.client.inject, ['slots', 'locale', 'sidebarRightTabs'])
check('slots.inject targets', mounted.injected, ['sidebar.right.pane.tab'])

check('tab types registered', mounted.tabTypes.length, 1)
const tab = mounted.tabTypes[0]
check('tab type id', tab?.id, 'spur-panel')
check('tab type kind', tab?.kind, 'spur')
check('tab type title', tab?.title('sidebar://spur'), '会话保活提醒')
check('tab type guide entries', tab?.guide?.length, 1)
check('guide entry id', tab?.guide?.[0]?.id, 'spur')
check('guide entry title', tab?.guide?.[0]?.title(), '会话保活提醒')
checkTrue('guide entry description', typeof tab?.guide?.[0]?.description() === 'string')

check('body registrations', mounted.registrations.length, 1)
check('body slot', mounted.registrations[0]?.definition?.name, 'sidebar.right.pane.tab')
check('body key equals the type id', mounted.registrations[0]?.definition?.key, 'spur-panel')
check('body locale namespace', mounted.registrations[0]?.definition?.locale, 'spur')

const zhKeys = Object.keys(mounted.dictionaries.spur?.zh ?? {}).sort()
const enKeys = Object.keys(mounted.dictionaries.spur?.en ?? {}).sort()
checkTrue('dictionaries: zh is not empty', zhKeys.length > 20)
check('dictionaries: zh and en carry the same keys', zhKeys, enKeys)
checkTrue('dictionaries: every zh value is a string', zhKeys.every((key) => typeof mounted.dictionaries.spur.zh[key] === 'string'))
checkTrue('dictionaries: every en value is a string', enKeys.every((key) => typeof mounted.dictionaries.spur.en[key] === 'string'))

// ── 首屏（还在读设置） ───────────────────────────────────────────────────────
const loadingPanel = mounted.registrations[0].component
const loadingTree = loadingPanel({ t: (key) => key, sessionId: 'session-1' })
checkTrue('panel: loading render returns a node', loadingTree !== null && loadingTree !== undefined)
checkTrue('panel: loading render mentions the loading key', JSON.stringify(loadingTree).includes('loading'))

// ── 读到设置之后：默认关闭 ───────────────────────────────────────────────────
const config = {
  compactFloorPercent: 60,
  shutdownOnHalt: false,
  shutdownGraceSeconds: 60,
  shutdownDryRun: false,
  autoTaskMode: false,
  autoTaskHint: '一直做到最后一步\n在开始新的一步之前，记得使用上下文工具压缩会话',
  compactAfterIdleNudges: 3,
  enableGraceSeconds: 30,
  idleGapMinutes: 2,
}
const limits = {
  compactFloorPercent: { min: 1, max: 100, step: 5 },
  shutdownGraceSeconds: { min: 5, max: 600, step: 5 },
  compactAfterIdleNudges: { min: 0, max: 50, step: 1 },
  enableGraceSeconds: { min: 0, max: 600, step: 5 },
  idleGapMinutes: { min: 0, max: 60, step: 0.5 },
}
const baseSession = { id: 'session-1', live: true, status: 'idle', enabled: false, halted: null, nudges: 0, probes: 0, recentNudges: [], armed: false, shutdownAt: null, shutdownIssued: false }
const snapshot = {
  config,
  defaults: { ...config },
  limits,
  tools: { usage: true, compact: true },
  storage: true,
  reminder: '【保活提醒】你停下来了，「全部任务」确定完成了吗？\n\n1. 没完成就继续做。\n2. 上下文占用到 60% 才允许压缩。',
  session: baseSession,
}

/** Find the button whose label is the given dictionary key. */
function findButton(tree, key) {
  if (tree === null || typeof tree !== 'object') return undefined
  if (tree.type === 'button' && JSON.stringify(tree.props?.children).includes(key)) return tree
  return (tree.props?.children ?? []).map((child) => findButton(child, key)).find(Boolean)
}

/** Render the panel with one session state and an idle/running session snapshot. */
function render(sessions, running = false) {
  const harness = mount(react([{ ...snapshot, session: sessions }, { ...config }, false, null]))
  return harness.registrations[0].component({
    t: (key) => key,
    sessionId: 'session-1',
    useSession: (selector) => selector({ running }),
  })
}

const offTree = render(baseSession)
const offText = JSON.stringify(offTree)
checkTrue('panel: loaded render returns a node', offTree !== null && offTree !== undefined)
checkTrue('panel: shows the session section', offText.includes('session.title'))
checkTrue('panel: shows the global section', offText.includes('params.title'))
checkTrue('panel: shows the compaction floor value', offText.includes('"60"'))
checkTrue('panel: shows the reminder title', offText.includes('reminder.title'))
checkTrue('panel: shows the reminder message', offText.includes('保活提醒') && offText.includes('60%'))
checkTrue('panel: shows the reminder hint', offText.includes('reminder.hint'))
checkTrue('panel: no save button (changes save themselves)', !offText.includes('"save"'))
checkTrue('panel: keeps the reset button', offText.includes('"reset"'))
checkTrue('panel: no removed settings survive', !offText.includes('params.consecutive') && !offText.includes('params.total') && !offText.includes('params.todos') && !offText.includes('params.prose') && !offText.includes('params.policy'))
checkTrue('panel: shows the shutdown switch', offText.includes('params.shutdown'))
checkTrue('panel: shows the auto-task switch', offText.includes('params.autoTask'))
checkTrue('panel: shows the editable auto-task text', offText.includes('params.autoTaskText'))
checkTrue('panel: the textarea carries the configured text', offText.includes('一直做到最后一步'))
checkTrue('panel: shows the auto-compact field', offText.includes('params.compactNudges'))
checkTrue('panel: shows the minimum-gap field', offText.includes('params.gap'))
checkTrue('panel: shows the cool-down field', offText.includes('params.grace'))
checkTrue('panel: keeps the interval out of the panel', !offText.includes('params.interval'))
checkTrue('panel: keeps the idle switch out of the panel', !offText.includes('params.idle'))
checkTrue('panel: default is off', offText.includes('"OFF"'))
checkTrue('panel: says the session is not enabled', offText.includes('session.disabledHint'))
checkTrue('panel: shows the zero counters', offText.includes('session.probes'))
checkTrue('panel: shows the empty reminder history', offText.includes('session.noRecent'))
checkTrue('panel: manual nudge disabled while off', findButton(offTree, 'session.nudgeNow')?.props?.disabled === true)
checkTrue('panel: no tool hint while both tools exist', !offText.includes('tools.missing'))
checkTrue('panel: no storage warning while the profile exists', !offText.includes('storageMissing'))

// 已启用、空闲、已排定提醒：开关 ON，按钮可用
const onTree = render({ ...baseSession, enabled: true, armed: true, nudges: 2, probes: 5, recentNudges: [Date.now() - 600_000, Date.now() - 300_000] })
const onText = JSON.stringify(onTree)
checkTrue('panel: enabled shows ON', onText.includes('"ON"'))
checkTrue('panel: enabled hides the disabled hint', !onText.includes('session.disabledHint'))
checkTrue('panel: enabled shows the armed hint', onText.includes('session.armed'))
checkTrue('panel: shows the probe and reminder counters', onText.includes('session.probes'))
checkTrue('panel: lists the recent reminder times', onText.includes('session.recent'))
checkTrue('panel: enabled allows the manual nudge', findButton(onTree, 'session.nudgeNow')?.props?.disabled === false)

// 主智能体声明完成：开关回到 OFF，说明原因
const doneTree = render({ ...baseSession, enabled: true, halted: 'done' })
const doneText = JSON.stringify(doneTree)
checkTrue('panel: done shows OFF', doneText.includes('"OFF"'))
checkTrue('panel: done explains why', doneText.includes('session.doneHint'))
checkTrue('panel: done disables the manual nudge', findButton(doneTree, 'session.nudgeNow')?.props?.disabled === true)

// 主智能体声明进行不下去：同样是 OFF，但原因文案不同
const blockedTree = render({ ...baseSession, enabled: true, halted: 'blocked' })
const blockedText = JSON.stringify(blockedTree)
checkTrue('panel: blocked shows OFF', blockedText.includes('"OFF"'))
checkTrue('panel: blocked explains why', blockedText.includes('session.blockedHint'))
checkTrue('panel: blocked does not reuse the done hint', !blockedText.includes('session.doneHint'))
checkTrue('panel: blocked disables the manual nudge', findButton(blockedTree, 'session.nudgeNow')?.props?.disabled === true)

// 主智能体声明暂停：同样是 OFF，文案是「等你回来」
const pausedTree = render({ ...baseSession, enabled: true, halted: 'paused' })
const pausedText = JSON.stringify(pausedTree)
checkTrue('panel: paused label shows OFF', pausedText.includes('"OFF"'))
checkTrue('panel: paused label explains why', pausedText.includes('session.pausedHint'))
checkTrue('panel: paused label does not reuse other hints', !pausedText.includes('session.doneHint') && !pausedText.includes('session.blockedHint'))

// 自动关机：排定与已发起的两种提示
const scheduledTree = render({ ...baseSession, enabled: true, halted: 'done', shutdownAt: Date.now() + 300_000 })
checkTrue('panel: shutdown schedule hint', JSON.stringify(scheduledTree).includes('session.shutdown'))
const issuedTree = render({ ...baseSession, enabled: true, halted: 'blocked', shutdownIssued: true, shutdownDeadline: Date.now() - 1_000 })
checkTrue('panel: shutdown issued hint', JSON.stringify(issuedTree).includes('session.shutdownIssued'))

// 宽限期内：倒计时 + 撤销按钮；宽限期过后：没有按钮
const liveShutdown = render({ ...baseSession, enabled: true, halted: 'done', shutdownIssued: true, shutdownDeadline: Date.now() + 60_000 })
const liveText = JSON.stringify(liveShutdown)
checkTrue('panel: shutdown countdown shown', liveText.includes('session.shutdownCountdown'))
checkTrue('panel: cancel shutdown button shown', findButton(liveShutdown, 'session.cancelShutdown') !== undefined)
const expiredShutdown = render({ ...baseSession, enabled: true, halted: 'done', shutdownIssued: true, shutdownDeadline: Date.now() - 1_000 })
checkTrue('panel: expired shutdown has no cancel button', findButton(expiredShutdown, 'session.cancelShutdown') === undefined)

// 会话正在跑：显示运行中、说明不会打扰、按钮禁用
const runningTree = render({ ...baseSession, enabled: true }, true)
const runningText = JSON.stringify(runningTree)
checkTrue('panel: running shows the running state', runningText.includes('session.state.running'))
checkTrue('panel: running explains the wait', runningText.includes('session.runningHint'))
checkTrue('panel: running disables the manual nudge', findButton(runningTree, 'session.nudgeNow')?.props?.disabled === true)

// 没有上下文工具：提示一行
const bare = mount(react([{ ...snapshot, tools: { usage: false, compact: false } }, { ...config }, false, null]))
const bareTree = bare.registrations[0].component({ t: (key) => key, sessionId: 'session-1' })
checkTrue('panel: hints when the context tools are missing', JSON.stringify(bareTree).includes('tools.missing'))

// ── 钩子顺序：首屏提前 return 之后不能再有钩子 ─────────────────────────────
// React 规则是每次渲染的钩子数量与顺序必须一致。面板首屏会提前 return，
// 任何钩子（包括 `useSession` 这种标准 prop）都必须写在它之前，否则第二次
// 渲染会多一个钩子，整个 slot entry 直接崩掉（React #310）。
{
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  const early = source.indexOf('if (state === null || draft === null)')
  checkTrue('panel: has the loading early return', early > 0)
  checkTrue('panel: no hook after the early return', !/React\.use[A-Z]|useSession\(/.test(source.slice(early)))
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES:\n${failures.join('\n')}`)
process.exitCode = failures.length === 0 ? 0 : 1
