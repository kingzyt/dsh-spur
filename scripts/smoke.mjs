/**
 * 脱离 harness 的冒烟检查：用桩上下文加载插件，喂会话事件、跑真实计时器，
 * 直接调用 `spur_reply` 工具与面板那两条 HTTP 路由，断言该提醒与不该提醒的情况。
 *
 * 用法：`node scripts/smoke.mjs`（在插件目录里）。设置文件写到临时目录，
 * 脚本结束会删掉。
 *
 * 覆盖不到的部分：浏览器里的面板渲染与真实 `agent.followup()` 注入，只能在
 * 运行中的会话里验证（见 README 的验证一节）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const settingsRoot = mkdtempSync(join(tmpdir(), 'spur-smoke-'))
process.env.DSH_PROFILE_DIR = settingsRoot

const plugin = await import(pathToFileURL(join(here, '..', 'src', 'index.js')).href)

const failures = []
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
const checkTrue = (label, value) => {
  if (value !== true) failures.push(`${label}\n  expected: true\n  actual:   ${JSON.stringify(value)}`)
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Session ids are unique for the whole run, so persisted records never leak between cases. */
let counter = 0

/** One isolated plugin instance with fake services. */
function createHarness(config, env = {}) {
  const listeners = new Map()
  const logs = { info: [], warn: [] }
  const agents = new Map()
  const routes = []
  const tools = []

  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  const ctx = {
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      debug: () => {},
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    effect(factory) {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    get(name) {
      if (name === 'goals') {
        if (env.hasGoals === false) return undefined
        return { get: () => env.goal }
      }
      if (name === 'tools') {
        if (env.hasToolsService === false) return undefined
        const registered = new Set(env.tools ?? [])
        return { get: (tool) => (registered.has(tool) ? { name: tool } : undefined) }
      }
      if (name === 'connection') {
        if (env.connection === false) return undefined
        return {
          fetch: {
            register(route) {
              routes.push(route)
              return () => {
                const index = routes.indexOf(route)
                if (index >= 0) routes.splice(index, 1)
                return Promise.resolve()
              }
            },
          },
        }
      }
      if (name === 'profileContext') {
        return env.profileContext === false ? undefined : { name: 'smoke', dir: settingsRoot, home: settingsRoot }
      }
      if (name === 'compaction') {
        if (env.compaction === false) return undefined
        return {
          async compactNow(agent) {
            harness.compactions.push(agent.id)
            return { compactionId: 'fake' }
          },
        }
      }
      return undefined
    },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
  }

  // The cases drive the timer directly; the cool-down has its own test.
  plugin.apply(ctx, { enableGraceSeconds: 0, ...(config ?? {}) })

  const harness = {
    logs,
    agents,
    routes,
    tools,
    compactions: [],
    addAgent({ origin = 'user', delegationDepth = 0, status = 'idle', hasPending = false, parentSession } = {}) {
      counter += 1
      const session = { id: `session-${counter}`, header: { origin, delegationDepth, parentSession } }
      return harness.reviveAgent(session, { status, hasPending })
    },
    /** Attach a fresh agent to an existing session, as a page refresh does. */
    reviveAgent(session, { status = 'idle', hasPending = false } = {}) {
      const agent = {
        id: session.id,
        session,
        status,
        inbox: { hasPending },
        delivered: [],
        sections: [],
        ctx: { systemPrompt: { section: () => () => {} } },
        followup(message) {
          if (this.status !== 'idle') throw new Error('agent is busy')
          this.delivered.push(message)
          this.status = 'running'
          emit('agent/status', { agent: this, status: 'running' })
        },
      }
      agents.set(session.id, agent)
      emit('agent/created', { agent })
      return { session, agent }
    },
    async callTool(agent, args) {
      const definition = tools.find((candidate) => candidate.name === 'spur_reply')
      if (definition === undefined) throw new Error('spur_reply is not registered')
      return await definition.execute(args, { agent })
    },
    emit,
    turnStart(session, agent) {
      if (agent !== undefined) {
        agent.status = 'running'
        emit('agent/status', { agent, status: 'running' })
      }
      emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    },
    idleThenTurnEnd(session, agent, reason = 'completed') {
      agent.status = 'idle'
      emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } })
      // The real runtime announces the transition only after the turn is over.
      emit('agent/status', { agent, status: 'idle' })
    },
    userSpoke(session) {
      emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } })
    },
    disposeAgent(agent) {
      agents.delete(agent.id)
      emit('agent/disposed', { agent })
    },
    async call(path, init) {
      const pathname = path.split('?')[0]
      const route = routes.find((candidate) => candidate.path.split('?')[0] === pathname)
      if (route === undefined) throw new Error(`route ${pathname} is not registered`)
      return await route.fetch(new Request(`http://localhost${path}`, init))
    },
    async callJson(path, init) {
      const response = await harness.call(path, init)
      return { status: response.status, body: await response.json() }
    },
    async enable(sessionId, enabled = true) {
      return harness.callJson('/api/spur.action', {
        method: 'POST',
        body: JSON.stringify({ action: 'session', sessionId, enabled }),
      })
    },
    async runTurn(session, agent) {
      harness.turnStart(session)
      harness.idleThenTurnEnd(session, agent)
      await sleep(WAIT)
    },
  }
  return harness
}

const FAST = 0.002 // 120 ms，让真实计时器跑得快一点
const WAIT = 220

// ── 默认关闭：不打开开关就什么都不提醒 ───────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.runTurn(session, agent)
  check('disabled by default: no nudge', agent.delivered.length, 0)
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('disabled by default: state says off', state.body.session.enabled, false)
  check('disabled by default: no halt label', state.body.session.halted, null)
}

// ── 打开之后：到点提醒，文案只有两条内容，不解释机制 ─────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, { tools: ['context_usage', 'compact_context'] })
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session)
  check('enabled: nothing before the timer', agent.delivered.length, 0)
  h.idleThenTurnEnd(session, agent)
  await sleep(WAIT)
  check('enabled: one nudge', agent.delivered.length, 1)
  const message = agent.delivered[0]
  check('nudge: role', message.role, 'user')
  check('nudge: source kind', message.source.kind, 'spur')
  check('nudge: source form', message.source.form, 'notice')
  check('nudge: summary', message.source.summary, '保活提醒（第 1 次）')
  checkTrue('nudge: id is a uuid', /^[0-9a-f-]{36}$/.test(message.id))
  const text = message.content.map((block) => block.text).join('\n')
  checkTrue('nudge: says the tasks are not all done', text.includes('全部任务'))
  checkTrue('nudge: says do not slack', text.includes('不要偷懒'))
  checkTrue('nudge: states the 60% rule', text.includes('60%'))
  checkTrue('nudge: never gates compaction behind the percentage', text.includes('不受这个百分比限制'))
  checkTrue('nudge: names context_usage', text.includes('context_usage'))
  checkTrue('nudge: names compact_context', text.includes('compact_context'))
  checkTrue('nudge: explains no mechanism', !text.includes('spur_reply'))
  checkTrue('nudge: frozen message', Object.isFrozen(message) && Object.isFrozen(message.content[0]))
  console.log(`--- reminder text ---\n${text}\n`)
}

// ── 没有次数上限：连续停就让连续提醒 ─────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  for (let round = 0; round < 4; round += 1) await h.runTurn(session, agent)
  check('no cap: four stops keep getting nudged', agent.delivered.length, 4)
  check('no cap: summary keeps counting', agent.delivered.at(-1)?.source.summary, '保活提醒（第 4 次）')
}

// ── 回复「已经完成所有任务」：提醒关闭，用户再说话也不恢复 ───────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  const reply = await h.callTool(agent, { reply: '  已经完成所有任务。 ' })
  check('done label: recorded', [reply.halted, reply.reason], [true, 'done'])
  checkTrue('done label: result text says closed', reply.text.includes('关闭'))
  await h.runTurn(session, agent)
  check('done label: no nudge', agent.delivered.length, 0)
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('done label: state says halted', state.body.session.halted, 'done')
  await h.runTurn(session, agent)
  check('done label: still quiet on the next turn', agent.delivered.length, 0)
  h.userSpoke(session)
  await h.runTurn(session, agent)
  check('done label: user message does not reopen it', agent.delivered.length, 0)
}

// ── 回复「进行不下去」：同样关闭，面板能看到是卡住而不是做完 ─────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  const reply = await h.callTool(agent, { reply: '进行不下去' })
  check('blocked label: recorded', [reply.halted, reply.reason], [true, 'blocked'])
  checkTrue('blocked label: result text says closed', reply.text.includes('关闭'))
  await h.runTurn(session, agent)
  check('blocked label: no nudge', agent.delivered.length, 0)
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('blocked label: state says blocked', state.body.session.halted, 'blocked')
  h.userSpoke(session)
  await h.runTurn(session, agent)
  check('blocked label: user message does not reopen it', agent.delivered.length, 0)
}

// ── 回复「暂停」：同样关闭，等你回来再开 ────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  const reply = await h.callTool(agent, { reply: '暂停' })
  check('paused label: recorded', [reply.halted, reply.reason], [true, 'paused'])
  checkTrue('paused label: result text says closed', reply.text.includes('关闭'))
  await h.runTurn(session, agent)
  check('paused label: no nudge', agent.delivered.length, 0)
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('paused label: state says paused', state.body.session.halted, 'paused')
}

// ── 其他标签：提醒继续 ───────────────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  const reply = await h.callTool(agent, { reply: '还在做' })
  check('other label: not halted', reply.halted, false)
  checkTrue('other label: result text says continuing', reply.text.includes('继续'))
  await h.runTurn(session, agent)
  check('other label: nudge continues', agent.delivered.length, 1)
}

// ── 面板重新打开：清掉停用标签，提醒恢复 ─────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '进行不下去' })
  await h.runTurn(session, agent)
  check('reopen: quiet while halted', agent.delivered.length, 0)
  await h.enable(session.id, false)
  const off = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('reopen: switched off', off.body.session.enabled, false)
  const on = await h.enable(session.id, true)
  check('reopen: halt label cleared', on.body.session.halted, null)
  check('reopen: enabled again', on.body.session.enabled, true)
  await h.runTurn(session, agent)
  check('reopen: nudging resumes', agent.delivered.length, 1)
}

// ── 面板关掉：不再提醒，手动提醒也被拒绝 ─────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.enable(session.id, false)
  await h.runTurn(session, agent)
  check('switched off: no nudge', agent.delivered.length, 0)
  const refused = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'nudge', sessionId: session.id }),
  })
  check('switched off: manual nudge refused', refused.status, 409)
}

// ── 声明停用后自动关机：默认关；打开后隔一个间隔检查并执行（干跑） ───────────
{
  const h = createHarness({ idleGapMinutes: 0.002, shutdownOnHalt: true, shutdownDryRun: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '已经完成所有任务' })
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  checkTrue('shutdown: scheduled after a halt label', typeof state.body.session.shutdownAt === 'number')
  check('shutdown: not issued yet', state.body.session.shutdownIssued, false)
  await sleep(WAIT * 2)
  const after = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown: issued after the check', after.body.session.shutdownIssued, true)
  checkTrue('shutdown: dry run logged instead of running', h.logs.info.some((line) => line.includes('本应执行关机')))
}
{
  const h = createHarness({ idleGapMinutes: 0.002, shutdownOnHalt: true, shutdownDryRun: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '进行不下去' })
  await h.enable(session.id, true)
  await sleep(WAIT * 2)
  const after = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown: reopening before the check cancels it', after.body.session.shutdownIssued, false)
  checkTrue('shutdown: cancelled, nothing logged', !h.logs.info.some((line) => line.includes('本应执行关机')))
}
{
  const h = createHarness({ idleGapMinutes: 0.002, shutdownOnHalt: true, shutdownDryRun: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '已经完成所有任务' })
  await sleep(WAIT * 2)
  const issued = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown cancel: issued first', issued.body.session.shutdownIssued, true)
  checkTrue('shutdown cancel: deadline published', typeof issued.body.session.shutdownDeadline === 'number')
  const cancelled = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'shutdown-cancel', sessionId: session.id }),
  })
  check('shutdown cancel: 200', cancelled.status, 200)
  check('shutdown cancel: state cleared', cancelled.body.session.shutdownIssued, false)
  checkTrue('shutdown cancel: dry run logged the abort', h.logs.info.some((line) => line.includes('已撤销会话')))
  const again = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'shutdown-cancel', sessionId: session.id }),
  })
  check('shutdown cancel: second cancel is refused', again.status, 409)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, shutdownOnHalt: true, shutdownDryRun: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '暂停' })
  await sleep(WAIT * 2)
  await h.enable(session.id, true)
  const after = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown cancel: reopening the switch aborts it', after.body.session.shutdownIssued, false)
}
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '已经完成所有任务' })
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown: not scheduled while the option is off', state.body.session.shutdownAt, null)
  await sleep(WAIT * 2)
  checkTrue('shutdown: nothing ran while the option is off', !h.logs.info.some((line) => line.includes('关机')))
}

{
  const h = createHarness({ idleGapMinutes: 0.002, shutdownOnHalt: true, shutdownDryRun: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '暂停' })
  await sleep(WAIT * 2)
  const after = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('shutdown: a paused label also fires it', after.body.session.shutdownIssued, true)
}

// ── 自动任务模式的提示词可改 ─────────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002, autoTaskMode: true, autoTaskHint: '只做这一步，别问。' }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('custom hint: sent instead of the built-in text', text.includes('只做这一步，别问。'))
  checkTrue('custom hint: the built-in text is gone', !text.includes('4轮审评'))
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  checkTrue('custom hint: the preview uses it', state.body.reminder.includes('只做这一步，别问。'))
  checkTrue('custom hint: defaults still carry the built-in text', state.body.defaults.autoTaskHint.includes('4轮审评'))
}
{
  const h = createHarness({ idleGapMinutes: 0.002, autoTaskMode: true, autoTaskHint: '' }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('empty hint: the reminder keeps the two points', text.includes('不要偷懒') && text.includes('60%'))
  checkTrue('empty hint: no trailing block is bolted on', !text.endsWith('\n'))
}
// ── 自动任务模式：开关打开才追加那段提示 ────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('auto task off: no multi-step paragraph', !text.includes('一直做到最后一步'))
}
{
  const h = createHarness({ idleGapMinutes: 0.002, autoTaskMode: true }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('auto task on: says work to the last step', text.includes('一直做到最后一步'))
  checkTrue('auto task on: says compact before a new step', text.includes('使用上下文工具压缩会话'))
  checkTrue('auto task on: says skip review after four rounds', text.includes('4轮审评'))
  checkTrue('auto task on: says do not ask before the review settles', text.includes('审评在过关') && text.includes('继续审'))
  checkTrue('auto task on: says decide splits yourself', text.includes('自行判断'))
  checkTrue('auto task on: keeps the two standing points', text.includes('不要偷懒') && text.includes('60%'))
  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  checkTrue('auto task on: preview carries it', state.body.reminder.includes('一直做到最后一步'))
}

// ── 连续提醒没动静：主动压缩一次再叫醒 ──────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002, compactAfterIdleNudges: 2 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  await h.runTurn(session, agent)
  check('compact: two nudges without progress', agent.delivered.length, 2)
  check('compact: not yet', h.compactions.length, 0)
  await h.runTurn(session, agent)
  await sleep(WAIT)
  check('compact: ran once', h.compactions.length, 1)
  check('compact: reminder follows the compaction', agent.delivered.length, 3)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, compactAfterIdleNudges: 2 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  h.emit('session/event', session, { type: 'tool/result', data: { callId: 'c1' } })
  await h.runTurn(session, agent)
  check('compact: tool activity resets the streak', h.compactions.length, 0)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, compactAfterIdleNudges: 0 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  for (let round = 0; round < 4; round += 1) await h.runTurn(session, agent)
  check('compact: zero disables it', h.compactions.length, 0)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, compactAfterIdleNudges: 1 }, { compaction: false })
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  await h.runTurn(session, agent)
  await sleep(WAIT)
  check('compact: missing service still reminds', agent.delivered.length, 2)
  checkTrue('compact: missing service warns', h.logs.warn.some((line) => line.includes('没有压缩服务')))
}

// ── 面板：探查次数、提醒次数、最近三次提醒时间 ──────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const first = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('counters: one probe', first.body.session.probes, 1)
  check('counters: one reminder', first.body.session.nudges, 1)
  check('counters: one timestamp', first.body.session.recentNudges.length, 1)
  checkTrue('counters: timestamp is a number', typeof first.body.session.recentNudges[0] === 'number')

  // 到点但会话在跑：算一次探查，不算提醒
  h.turnStart(session)
  h.idleThenTurnEnd(session, agent)
  agent.status = 'running'
  await sleep(WAIT)
  const second = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('counters: the skipped tick still counts as a probe', second.body.session.probes, 2)
  check('counters: the skipped tick is not a reminder', second.body.session.nudges, 1)

  // 最近三次：多发两次之后只留最近三条
  agent.status = 'idle'
  for (let round = 0; round < 3; round += 1) {
    h.turnStart(session)
    h.idleThenTurnEnd(session, agent)
    await sleep(WAIT)
  }
  const third = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('counters: keeps only the last three timestamps', third.body.session.recentNudges.length, 3)
  checkTrue('counters: timestamps are ordered', third.body.session.recentNudges[0] <= third.body.session.recentNudges[2])
}

// ── 页面刷新（智能体重新挂载）后记录与开关都不丢 ────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002, enableGraceSeconds: 0.05 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const before = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('refresh: counters before', [before.body.session.probes, before.body.session.nudges], [1, 1])

  h.disposeAgent(agent)
  const revived = h.reviveAgent(session)
  const after = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('refresh: switch survives', after.body.session.enabled, true)
  check('refresh: probe count survives', after.body.session.probes, 1)
  check('refresh: reminder count survives', after.body.session.nudges, 1)
  check('refresh: recent times survive', after.body.session.recentNudges.length, 1)
  check('refresh: the timer is re-armed', after.body.session.armed, true)

  await h.callTool(revived.agent, { reply: '暂停' })
  h.disposeAgent(revived.agent)
  h.reviveAgent(session)
  const halted = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('refresh: halt label survives', halted.body.session.halted, 'paused')
}

// ── 落盘：设置与提醒记录都进 profile 目录，插件重载/重启后还在 ──────────────
{
  // 生产环境进程里没有 DSH_PROFILE_DIR，路径来自 profileContext 服务
  const savedEnv = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const state = await h.callJson('/api/spur.state')
  check('storage: profile context supplies the directory', state.body.storage, true)
  process.env.DSH_PROFILE_DIR = savedEnv
}
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  await sleep(400)

  // 模拟插件重载/DSH 重启：同一 profile 目录、新实例、同一个会话
  const h2 = createHarness({ idleGapMinutes: 0.002 }, {})
  h2.reviveAgent(session)
  const restored = await h2.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('records: switch restored', restored.body.session.enabled, true)
  check('records: probes restored', restored.body.session.probes, 1)
  check('records: reminders restored', restored.body.session.nudges, 1)
  check('records: recent times restored', restored.body.session.recentNudges.length, 1)

  // 停用标签也落盘
  await h.callTool(agent, { reply: '暂停' })
  await sleep(400)
  const h3 = createHarness({ idleGapMinutes: 0.002 }, {})
  h3.reviveAgent(session)
  const halted = await h3.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('records: halt label restored', halted.body.session.halted, 'paused')
}

// ── 空闲就提醒：agent/status 一变 idle 就发，不等间隔 ───────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  check('idle nudge: fires on the idle transition', agent.delivered.length, 1)
  check('idle nudge: the reminder is a notice', agent.delivered[0]?.source?.summary.startsWith('保活提醒'), true)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent, 'aborted')
  await sleep(WAIT)
  check('idle nudge: an aborted turn is not poked', agent.delivered.length, 1)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  await sleep(WAIT)
  check('idle nudge: a second idle drives the next round', agent.delivered.length, 2)
  checkTrue('idle nudge: every reminder keeps the two standing points', agent.delivered.every((message) => message.content[0].text.includes('不要偷懒')))
}
{
  // 默认 2 分钟的间隔：两次空闲挨得很近时，第二条要等间隔过去
  const h = createHarness({ idleGapMinutes: 2 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  await sleep(WAIT)
  check('idle gap: a second idle inside the gap waits', agent.delivered.length, 1)
}

// ── 开启后的反悔期：冷静期结束前一条都不发 ──────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002, enableGraceSeconds: 0.05 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  check('grace: no reminder inside the cool-down', agent.delivered.length, 0)
  await sleep(WAIT)
  check('grace: the reminder comes once it is over', agent.delivered.length, 1)
}
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const state = await h.callJson('/api/spur.state')
  check('grace: default is 30 seconds', state.body.defaults.enableGraceSeconds, 30)
  check('gap: default is 2 minutes', state.body.defaults.idleGapMinutes, 2)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, enableGraceSeconds: 0 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session, agent)
  h.idleThenTurnEnd(session, agent)
  check('grace: zero turns it off', agent.delivered.length, 1)
}

// ── 兜底巡检：空闲事件没来，也要在巡检周期内提醒 ────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002, watchdogSeconds: 0.005 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  // 故意不触发 turn/end 或 agent/status：模拟「事件丢了」的那种静默
  await sleep(WAIT * 2)
  check('watchdog: nudges a watched idle session with no event', agent.delivered.length, 1)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, watchdogSeconds: 0.005 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  agent.status = 'running'
  await sleep(WAIT * 2)
  check('watchdog: leaves a running session alone', agent.delivered.length, 0)
}
{
  const h = createHarness({ idleGapMinutes: 0.002, watchdogSeconds: 0.005 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.callTool(agent, { reply: '已经完成所有任务' })
  await sleep(WAIT * 2)
  check('watchdog: respects the halt label', agent.delivered.length, 0)
}

// ── 不是 completed 的回合：不提醒 ────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session)
  h.idleThenTurnEnd(session, agent, 'aborted')
  await sleep(WAIT)
  check('aborted turn: no nudge', agent.delivered.length, 0)
}

// ── 子会话本身：不提醒 ───────────────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent({ origin: 'subagent' })
  await h.enable(session.id)
  await h.runTurn(session, agent)
  check('subagent session: no nudge', agent.delivered.length, 0)
}

// ── 有当前目标也要提醒：开关是用户的决定，目标在跑不等于用户不想要提醒 ──────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, { goal: { id: 'g1', phase: 'active', activation: 'armed' } })
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  check('goal session: still nudged', agent.delivered.length, 1)
}

// ── 子代理还在跑：先不打扰，等它跑完再提醒 ──────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session, agent)
  const { agent: child } = h.addAgent({ origin: 'subagent', delegationDepth: 1, parentSession: session.id, status: 'running' })
  h.idleThenTurnEnd(session, agent)
  await sleep(WAIT)
  check('running subagent: no nudge while it works', agent.delivered.length, 0)
  child.status = 'idle'
  await sleep(WAIT)
  check('subagent finished: the reminder comes then', agent.delivered.length, 1)
}

// ── 到点时收件箱里还有别人的消息：让路 ──────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  h.turnStart(session)
  agent.inbox.hasPending = true
  h.idleThenTurnEnd(session, agent)
  await sleep(WAIT)
  check('foreign pending message: no nudge', agent.delivered.length, 0)
}

// ── 到点前会话被销毁：计时器不残留 ───────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id) // 开启后先排一个冷静期计时器
  h.disposeAgent(agent)
  await sleep(1100)
  check('disposed agent: no delayed nudge', agent.delivered.length, 0)
}

// ── 不往系统提示词里写任何东西 ───────────────────────────────────────────────
{
  const h = createHarness({}, {})
  const { agent } = h.addAgent()
  check('no policy section', agent.sections.length, 0)
}

// ── 工具面：会话主智能体只看到回复工具 ──────────────────────────────────────
{
  const h = createHarness({}, {})
  const exposed = h.tools.filter((tool) => tool.name !== 'spur_diag')
  check('tools: exactly one registration', exposed.length, 1)
  check('tools: name', exposed[0]?.name, 'spur_reply')
  check('tools: required reply parameter', exposed[0]?.parameters?.reply?.required, true)
}

// ── 提醒里的预算建议跟随上下文工具的存在 ─────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, { tools: ['context_usage'] })
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('usage only: names context_usage', text.includes('context_usage'))
  checkTrue('usage only: omits compact_context', !text.includes('compact_context'))
  checkTrue('usage only: still leaves compaction to the flow', text.includes('不受这个百分比限制'))
}
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('no context tools: no context_usage', !text.includes('context_usage'))
  checkTrue('no context tools: keeps the 60% rule', text.includes('60%'))
  checkTrue('no context tools: still leaves compaction to the flow', text.includes('不受这个百分比限制'))
}
{
  const h = createHarness({ idleGapMinutes: 0.002, compactFloorPercent: 75 }, { tools: ['context_usage', 'compact_context'] })
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  const text = agent.delivered[0]?.content.map((block) => block.text).join('\n') ?? ''
  checkTrue('configured floor reaches the reminder', text.includes('75%'))
}

// ── 面板：状态、保存配置、立即提醒 ───────────────────────────────────────────
{
  const env = { tools: ['context_usage', 'compact_context'] }
  const h = createHarness({ idleGapMinutes: 0.002 }, env)
  const { session, agent } = h.addAgent()

  const state = await h.callJson(`/api/spur.state?sessionId=${session.id}`)
  check('state: 200', state.status, 200)
  check('state: gap', state.body.config.idleGapMinutes, 0.002)
  check('state: no interval setting survives', state.body.config.intervalMinutes, undefined)
  check('state: defaults carried', state.body.defaults.idleGapMinutes, 2)
  check('state: session live', state.body.session.live, true)
  check('state: tools', state.body.tools, { usage: true, compact: true })
  checkTrue('state: reminder previewed', state.body.reminder.includes('全部任务'))
  checkTrue('state: reminder follows the floor', state.body.reminder.includes('60%'))

  const saved = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({
      action: 'config',
      sessionId: session.id,
      config: { ...state.body.config, idleGapMinutes: 3, compactFloorPercent: 70 },
    }),
  })
  check('config: 200', saved.status, 200)
  check('config: gap applied', saved.body.config.idleGapMinutes, 3)
  checkTrue('config: reminder follows the saved floor', saved.body.reminder.includes('70%'))
  const stored = JSON.parse(readFileSync(join(settingsRoot, 'spur', 'settings.json'), 'utf8'))
  check('config: written to disk', [stored.idleGapMinutes, stored.compactFloorPercent], [3, 70])

  await h.enable(session.id)
  const nudged = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'nudge', sessionId: session.id }),
  })
  check('nudge: 200', nudged.status, 200)
  check('nudge: delivered', agent.delivered.length, 1)

  agent.status = 'running'
  const busyRefused = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'nudge', sessionId: session.id }),
  })
  check('nudge while running: 409', busyRefused.status, 409)
  check('nudge while running: nothing queued', agent.delivered.length, 1)

  const unknown = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'nope' }),
  })
  check('unknown action: 400', unknown.status, 400)
}

// ── 保存过的设置在下一次加载时生效 ───────────────────────────────────────────
{
  const h = createHarness({}, {})
  const state = await h.callJson('/api/spur.state')
  check('persisted: gap', state.body.config.idleGapMinutes, 3)
}

// ── 草稿预览：只预览不保存 ───────────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, {})
  const state = await h.callJson('/api/spur.state')
  checkTrue('preview: off by default', !state.body.reminder.includes('一直做到最后一步'))
  const preview = await h.callJson('/api/spur.action', {
    method: 'POST',
    body: JSON.stringify({ action: 'preview', config: { ...state.body.config, autoTaskMode: true } }),
  })
  check('preview: 200', preview.status, 200)
  checkTrue('preview: renders the draft', preview.body.reminder.includes('一直做到最后一步'))
  const after = await h.callJson('/api/spur.state')
  checkTrue('preview: does not save', !after.body.reminder.includes('一直做到最后一步'))
}

// 清掉设置文件，后面的用例从默认值开始
rmSync(join(settingsRoot, 'spur'), { recursive: true, force: true })

// ── 没有 connection 服务时：工具还在，但没有面板路由 ─────────────────────────
{
  const h = createHarness({ idleGapMinutes: 0.002 }, { connection: false })
  check('no connection: no routes', h.routes.length, 0)
  const { agent } = h.addAgent()
  check('no connection: the tool still exists', h.tools.some((tool) => tool.name === 'spur_reply'), true)
  check('no connection: nothing is armed without a panel', agent.delivered.length, 0)
}

// ── 非法配置：报告并回落默认值 ───────────────────────────────────────────────
{
  const h = createHarness({ idleGapMinutes: -3, compactFloorPercent: 1.5 }, {})
  check('invalid config: two warnings', h.logs.warn.length, 2)
}
{
  const h = createHarness({ compactFloorPercent: 120 }, {})
  check('invalid floor: one warning', h.logs.warn.length, 1)
}
{
  const h = createHarness({ idleGapMinutes: -3 }, {})
  const { session, agent } = h.addAgent()
  await h.enable(session.id)
  await h.runTurn(session, agent)
  checkTrue('invalid gap is reported', h.logs.warn.some((line) => line.includes('idleGapMinutes')))
  check('invalid interval still drives from the idle event', agent.delivered.length, 1)
}

rmSync(settingsRoot, { recursive: true, force: true })

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES:\n${failures.join('\n')}`)
process.exitCode = failures.length === 0 ? 0 : 1
