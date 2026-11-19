/**
 * 会话保活提醒（spur）：一个纯机械的定时器，只做两件事——到点提醒、按标签关掉自己。
 *
 * 插件开着（用户在右侧面板里没关）时，每个正常结束的回合之后都会按间隔发一条提醒；
 * 提醒只讲两件事：任务没做完就继续、上下文到了 60% 才需要担心预算（流程要求压缩
 * 时照流程压，不受这个百分比限制）。它不读回复文本，
 * 不往系统提示词里塞任何东西，也不解释自己的机制。
 *
 * 停止只有两个口子，都由人之外的显式动作触发：
 * 1. 会话主智能体调用 `spur_reply`，在 reply 参数里填「已经完成所有任务」——本会话的
 *    提醒关闭，直到用户在面板里重新打开（用户再说新话也不会自动恢复）；
 * 2. 用户在右侧面板里关掉本会话。
 *
 * 触发之后走 `agent.followup()`：它在智能体空闲时开启一个新回合。消息的 source 带
 * `form: 'notice'`，界面上是一条可折叠的提示行。智能体正在跑的时候永远不会提醒：
 * 计时只在回合结束时排，到点那一刻还在跑就跳过，等这个回合结束再重排。
 *
 * 配置面板是右侧工具区里的一个页签（客户端半边在 client.js）。面板通过
 * GET `/api/spur.state` 读状态，POST `/api/spur.action` 保存配置、开关本会话、
 * 立即提醒一次。设置落在 `$DSH_PROFILE_DIR/spur/settings.json`，改完立即生效。
 *
 * 本文件不 import 任何 DSH 包：随附包在 profile 里能解析，本包的加载路径解析不到它们。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Stable Loader identity. */
export const name = 'spur'

/** Services that must exist before this plugin activates. */
export const inject = ['agents', 'tools']

/**
 * The paragraph appended to every reminder while the auto-task switch is on.
 * It is also the default value of the `autoTaskHint` option: the panel edits the
 * copy the host actually sends, and "restore defaults" brings this text back.
 */
const AUTO_TASK_HINT = [
  '一直做到最后一步，中途不用问我，除非遇到原则性的分歧无法决断，必须要问我，才问我问题，但仅仅把问题问出来，然后停止即可，因为我也没法回复',
  '在开始新的一步之前，记得使用上下文工具压缩会话，不然你会焦虑的',
  '中途遇到4轮审评还过不了的情况，就直接开工，不用再审',
  '审评在过关、或是4轮上限审完之前，不需要问我（只有过关和审到4轮不再审两种情况，其他情况都要继续审）',
  '遇到要不要拆的情况，自行判断，不用问我',
].join('\n')

/**
 * Every tunable value, with its default. The row's `config` and the panel's
 * saved file may set any subset; an invalid value is reported and the default kept.
 */
const DEFAULT_OPTIONS = {
  /** 提醒里允许压缩的最低上下文占用百分比。 */
  compactFloorPercent: 60,
  /** 主智能体声明停用之后，下一次检查时如果还停着就发起关机。默认关闭。 */
  shutdownOnHalt: false,
  /** 关机命令的宽限秒数，`shutdown /s /t` 用。 */
  shutdownGraceSeconds: 60,
  /** 只记日志、不真执行关机；用来试开关和跑冒烟。 */
  shutdownDryRun: false,
  /** 给多步计划这类长流程用的自动任务模式：打开后每条提醒追加一段提示。 */
  autoTaskMode: false,
  /** 追加的那段提示的正文：面板里可以直接改，恢复默认会回到内置文本。 */
  autoTaskHint: AUTO_TASK_HINT,
  /** 连续多少次提醒之间一次工具都没跑，就主动压缩一次会话；0 表示不压缩。 */
  compactAfterIdleNudges: 3,
  /** 打开会话开关之后的冷静期：这段时间里不发提醒，留出反悔余地。 */
  enableGraceSeconds: 30,
  /** 空闲触发时，两条提醒之间至少隔多少分钟：回合再短也不会连着催。 */
  idleGapMinutes: 2,
  /** 兜底巡检间隔（秒）：空闲事件万一没到，也不能让会话一直静着。 */
  watchdogSeconds: 60,
}

/** Durable message source of a nudge; also the label the Chat row shows. */
const SOURCE_KIND = 'spur'

/** The reply tool: the only channel through which the session turns its reminder off. */
const TOOL_NAME = 'spur_reply'

/**
 * The labels that turn this session's reminder off, and why each exists.
 * Borrowed from the built-in goal's phases: a task can end because it is done,
 * because the agent genuinely cannot go on, or because it is waiting on the
 * user. All three stop the timer until the user reopens the switch; none is
 * inferred from the reply text.
 */
const HALT_LABELS = new Map([
  ['已经完成所有任务', 'done'],
  ['进行不下去', 'blocked'],
  ['暂停', 'paused'],
])

/** Routes the panel talks to; both live under the web app's `/api` prefix. */
const STATE_ROUTE = '/api/spur.state'
const ACTION_ROUTE = '/api/spur.action'

/** Field bounds the panel offers as input hints; the validator only enforces sanity. */
const LIMITS = {
  compactFloorPercent: { min: 1, max: 100, step: 5 },
  shutdownGraceSeconds: { min: 5, max: 600, step: 5 },
  compactAfterIdleNudges: { min: 0, max: 50, step: 1 },
  enableGraceSeconds: { min: 0, max: 600, step: 5 },
  idleGapMinutes: { min: 0, max: 60, step: 0.5 },
}

/**
 * The directory this plugin owns. The launcher hands the profile facts to every
 * host plugin as `profileContext`, so the path works even when the process was
 * not started with `DSH_PROFILE_DIR` exported; the environment is only a
 * fallback for the smoke harness.
 * @param ctx - plugin context.
 * @returns its absolute path, or undefined outside a profiled Harness.
 */
function storageDir(ctx) {
  const profile = ctx.get('profileContext')
  let dir
  if (typeof profile?.dir === 'string' && profile.dir.length > 0) {
    dir = profile.dir
  } else if (typeof profile?.home === 'string' && profile.home.length > 0
    && typeof profile?.name === 'string' && profile.name.length > 0) {
    // Older launchers hand over home + name instead of the resolved directory.
    dir = join(profile.home, 'profiles', profile.name)
  } else {
    dir = process.env.DSH_PROFILE_DIR
  }
  return typeof dir === 'string' && dir.length > 0 ? join(dir, 'spur') : undefined
}

/**
 * The settings file this plugin owns. It lives under the profile directory, is
 * not the profile patch, and never holds secrets.
 * @param ctx - plugin context.
 * @returns its absolute path, or undefined outside a profiled Harness.
 */
function settingsPath(ctx) {
  const dir = storageDir(ctx)
  return dir === undefined ? undefined : join(dir, 'settings.json')
}

/**
 * The per-session record file: switches, halt labels, counters and the last
 * three reminder times. Written a moment after every change.
 * @param ctx - plugin context.
 * @returns its absolute path, or undefined outside a profiled Harness.
 */
function recordsPath(ctx) {
  const dir = storageDir(ctx)
  return dir === undefined ? undefined : join(dir, 'records.json')
}

/**
 * Read the saved settings, tolerating a missing or broken file.
 * @param ctx - plugin context, for the warning log.
 * @returns the saved object, or an empty one.
 */
function readSettings(ctx) {
  const file = settingsPath(ctx)
  if (file === undefined) return {}
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger.warn(`spur: 读不到设置文件 ${file}：${String(error)}`)
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    ctx.logger.warn(`spur: 设置文件不是合法 JSON，已忽略：${String(error)}`)
    return {}
  }
}

/**
 * Write the settings file.
 * @param options - complete option set to persist.
 * @throws when the file cannot be written.
 */
function writeSettings(ctx, options) {
  const file = settingsPath(ctx)
  if (file === undefined) throw new Error('这个部署没有 profile 目录（DSH_PROFILE_DIR 未设置），设置无法保存')
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read the per-session record file, tolerating a missing or broken file.
 * @param ctx - plugin context, for the warning log.
 * @returns the saved `sessions` object, or an empty one.
 */
function readRecords(ctx) {
  const file = recordsPath(ctx)
  if (file === undefined) return {}
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger.warn(`spur: 读不到记录文件 ${file}：${String(error)}`)
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    const sessions = parsed?.sessions
    return sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {}
  } catch (error) {
    ctx.logger.warn(`spur: 记录文件不是合法 JSON，已忽略：${String(error)}`)
    return {}
  }
}

/**
 * Write the per-session record file.
 * @param ctx - plugin context, for the warning log.
 * @param sessions - plain JSON record map.
 */
function writeRecords(ctx, sessions) {
  const file = recordsPath(ctx)
  if (file === undefined) return
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    ctx.logger.warn(`spur: 写不进记录文件 ${file}：${String(error)}`)
  }
}

/**
 * Read one option set, reporting every value it rejects.
 * @param ctx - plugin context, for the warning log.
 * @param raw - raw values from the row config and the saved file.
 * @param base - values to keep when `raw` omits a field.
 * @returns complete options with defaults applied.
 */
function resolveOptions(ctx, raw, base = DEFAULT_OPTIONS) {
  const source = raw ?? {}
  const options = { ...base }
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    const value = source[key]
    if (value === undefined) continue
    const fallback = options[key]
    if (typeof DEFAULT_OPTIONS[key] === 'boolean') {
      if (typeof value === 'boolean') {
        options[key] = value
        continue
      }
    } else if (typeof DEFAULT_OPTIONS[key] === 'string') {
      if (typeof value === 'string') {
        options[key] = value
        continue
      }
    } else if (typeof value === 'number' && Number.isFinite(value)
      && (value > 0 || ((key === 'compactAfterIdleNudges' || key === 'enableGraceSeconds' || key === 'idleGapMinutes') && value === 0))
      && (key === 'idleGapMinutes' || key === 'enableGraceSeconds' || key === 'watchdogSeconds' || Number.isSafeInteger(value))) {
      // `compactFloorPercent` is a percentage; anything above 100 can never be met.
      if (!(key === 'compactFloorPercent' && value > 100)) {
        options[key] = value
        continue
      }
    }
    ctx.logger.warn(`spur: 忽略无效配置 ${key}=${JSON.stringify(value)}，沿用 ${String(fallback)}`)
  }
  return options
}

/**
 * The subset the panel edits and the file stores.
 * @param options - complete option set.
 * @returns plain JSON copy.
 */
function publicConfig(options) {
  const copy = {}
  for (const key of Object.keys(DEFAULT_OPTIONS)) copy[key] = options[key]
  return copy
}

/**
 * Whether one session is a delegated child, which this plugin leaves alone: its
 * parent owns that result and a second voice in the child only muddles the run.
 * @param session - session to classify.
 * @returns true for subagent sessions.
 */
function isSubagent(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/**
 * Which of the local context tools this profile exposes. The reminder tells the
 * model to check real numbers before it guesses about the budget; that sentence
 * disappears when the reader is not registered, so the text never names a
 * missing tool.
 * @param ctx - plugin context.
 * @returns whether `context_usage` and `compact_context` are registered.
 */
function availableContextTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return { usage: false, compact: false }
  return {
    usage: tools.get('context_usage') !== undefined,
    compact: tools.get('compact_context') !== undefined,
  }
}

/**
 * Render the model-facing reminder. It states the two rules and nothing about
 * how the plugin works.
 * @param options - resolved options.
 * @param tools - context tool availability.
 * @returns the message content.
 */
function reminderText(options, tools) {
  const floor = options.compactFloorPercent
  // The percentage is a "do not worry before this" line, never a permission gate:
  // a flow that compacts at step boundaries (multi-step-plan) must not be blocked
  // by a reminder that only knows about the budget.
  const budget = tools.usage && tools.compact
    ? `上下文到 ${floor}% 以上才需要担心预算：先用 context_usage 查真实占用。${floor}% 以前不用焦虑，上下文够用；流程要求压缩时（例如开始新的一步、切换任务）照流程用 compact_context 压，不受这个百分比限制。`
    : tools.usage
      ? `上下文到 ${floor}% 以上才需要担心预算：先用 context_usage 查真实占用。${floor}% 以前不用焦虑，上下文够用；流程要求压缩时照流程走，不受这个百分比限制。`
      : `上下文到 ${floor}% 以上才需要担心预算，${floor}% 以前不用焦虑，上下文够用；流程要求压缩时照流程走，不受这个百分比限制。`
  const extra = options.autoTaskMode ? String(options.autoTaskHint ?? '').trim() : ''
  return [
    '【保活提醒】你停下来了，「全部任务」确定完成了吗？',
    '',
    '1. 没完成就继续做，不要偷懒，也不要停下来等确认。',
    `2. ${budget}`,
    ...extra === '' ? [] : ['', extra],
  ].join('\n')
}

/** Freeze one message deeply, mirroring the harness message contract. */
function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze))
  if (value !== null && typeof value === 'object') {
    const copy = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = deepFreeze(entry)
    return Object.freeze(copy)
  }
  return value
}

/**
 * Build the user-role message one nudge delivers.
 * @param text - model-facing content.
 * @param summary - collapsed row account.
 * @returns a frozen message the inbox accepts.
 */
function nudgeMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  })
}

/** Render an unknown thrown value for a log line. */
function describeThrown(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Answer one panel request with JSON.
 * @param value - JSON body.
 * @param status - HTTP status.
 * @returns the response.
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Strip trailing punctuation and whitespace from a reply label.
 * @param value - raw label.
 * @returns the comparable label.
 */
function normalizeLabel(value) {
  return String(value ?? '').trim().replace(/[。.!！\s]+$/u, '')
}

/**
 * Install the reply tool, the timer drive, and the panel routes.
 * @param ctx - host context with `agents` and `tools`.
 * @param config - row config; see {@link DEFAULT_OPTIONS}.
 */
export function apply(ctx, config = {}) {
  const persisted = readSettings(ctx)
  const options = resolveOptions(ctx, { ...(config ?? {}), ...persisted })
  /** Per-session timer state, keyed by session id. */
  const states = new Map()
  /** Sessions the main agent halted, with the reason; quiet until the user reopens them. */
  const halted = new Map()
  /** Sessions with a pending auto-shutdown check, and when it is due. */
  const shutdownDue = new Map()
  /** Sessions whose shutdown command already ran, with its grace deadline. */
  const shutdownIssued = new Map()
  /** Cancels in-flight proactive compactions when the plugin unloads. */
  const compactionLifetime = new AbortController()
  /** Sessions the user switched on from the panel; nothing is armed while absent. */
  const enabled = new Set()

  // Restore what the last run knew: switches, halt labels and the counters the
  // panel shows. Files live in the profile directory, so a reload or restart no
  // longer looks like a reset.
  const restored = readRecords(ctx)
  const restoreCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)
  for (const [id, record] of Object.entries(restored)) {
    if (record === null || typeof record !== 'object') continue
    states.set(id, {
      timer: undefined,
      token: 0,
      nudges: restoreCount(record.nudges),
      idleNudges: 0,
      probes: restoreCount(record.probes),
      recentNudges: Array.isArray(record.recentNudges)
        ? record.recentNudges.filter((at) => typeof at === 'number').slice(-3)
        : [],
      lastTurnCompleted: false,
      lastNudgeAt: 0,
      enabledAt: record.enabled === true ? Date.now() : 0,
    })
    if (record.enabled === true) enabled.add(id)
    if (record.halted === 'done' || record.halted === 'blocked' || record.halted === 'paused') halted.set(id, record.halted)
  }

  /**
   * Counters for the "why did it go quiet" question, surfaced by `spur_diag`.
   * They cost nothing and answer the only question logs cannot answer offline.
   */
  const stats = {
    statusIdle: 0,
    statusRunning: 0,
    turnStart: 0,
    turnEnd: 0,
    idleNudges: 0,
    watchdogRuns: 0,
    watchdogNudges: 0,
    lastStatusAt: 0,
    lastWatchdogAt: 0,
  }

  /** Write the current per-session record map to the profile directory. */
  const persistRecords = () => {
    const sessions = {}
    for (const [id, state] of states) {
      sessions[id] = {
        enabled: enabled.has(id),
        halted: halted.get(id) ?? null,
        probes: state.probes,
        nudges: state.nudges,
        recentNudges: state.recentNudges,
      }
    }
    writeRecords(ctx, sessions)
  }

  let persistTimer
  /** Coalesce writes: several counters change within one turn. */
  const schedulePersist = () => {
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      persistRecords()
    }, 300)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  /**
   * Read (or create) the timer state of one session.
   * @param session - session whose state is read.
   * @returns its mutable state.
   */
  const stateFor = (session) => {
    const existing = states.get(session.id)
    if (existing !== undefined) return existing
    const state = { timer: undefined, token: 0, nudges: 0, idleNudges: 0, probes: 0, recentNudges: [], lastTurnCompleted: false, lastNudgeAt: 0, enabledAt: 0 }
    states.set(session.id, state)
    return state
  }

  /**
   * Cancel a pending timer.
   * @param state - session state holding it.
   */
  const disarm = (state) => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /**
   * Whether a stopped session should be woken.
   * @param agent - the live agent whose session is inspected.
   * @returns true when the reminder applies.
   */
  const needsNudge = (agent) => {
    const sessionId = agent.session.id
    // The switch is the user's decision and defaults to off; the reply label is
    // the agent's. Both have to agree before a reminder is armed.
    if (!enabled.has(sessionId) || halted.has(sessionId)) return false
    // A current goal does not suppress the reminder. Turning the switch on is the
    // user saying "keep this session alive"; a goal running beside it only means
    // two drivers, which is exactly what the user asked for. Treating the goal as
    // an opt-out left a real session silent for hours.
    return true
  }

  /**
   * Whether any live descendant subagent of one session is still running.
   * The session header's `parentSession` is the only tree link available.
   * @param sessionId - the main session's id.
   * @returns true while at least one descendant is not idle.
   */
  const descendantsRunning = (sessionId) => {
    for (const other of ctx.agents.list()) {
      if (other.status === 'idle') continue
      if (other.session.header?.origin !== 'subagent') continue
      let cursor = other.session.header.parentSession
      for (let depth = 0; cursor !== undefined && depth < 32; depth += 1) {
        if (cursor === sessionId) return true
        cursor = ctx.agents.get(cursor)?.session.header?.parentSession
      }
    }
    return false
  }

  /**
   * Queue one reminder after re-checking every fact it depends on.
   * @param agent - live agent to wake.
   * @param state - its session state.
   * @param token - disarm token captured when the timer was armed.
   */
  const deliver = (agent, state, token) => {
    // Every timer tick is one probe, whether or not it ends in a reminder.
    state.probes += 1
    schedulePersist()
    if (state.token !== token) return
    if (ctx.agents.get(agent.id) !== agent) return
    if (agent.status !== 'idle') return
    if (agent.inbox?.hasPending === true) return
    if (!needsNudge(agent)) return
    // Inside the post-enable cool-down: check again when it is over.
    if (graceLeft(state) > 0) {
      armIn(agent, state, graceLeft(state))
      return
    }
    // Inside the minimum gap after the previous reminder: wait it out.
    if (gapLeft(state) > 0) {
      armIn(agent, state, gapLeft(state))
      return
    }
    // A running subagent means work is still in flight somewhere else in this
    // tree; wait another interval instead of poking the parent.
    if (descendantsRunning(agent.session.id)) {
      arm(agent, state)
      return
    }
    // Several reminders in a row without a single tool run look like a session
    // squeezed by its context: compact it once, then wake it in the clean one.
    if (options.compactAfterIdleNudges > 0 && state.idleNudges >= options.compactAfterIdleNudges) {
      compactThenNudge(agent, state, token)
      return
    }
    queue(agent, state)
  }

  /**
   * Compact the session before the next reminder when the last several
   * reminders found the agent without a single tool run. The compaction is the
   * host compaction service the profile already mounts; without one, the
   * reminder simply goes out as usual.
   * @param agent - idle agent whose session is compacted.
   * @param state - its session state.
   * @param token - disarm token captured when the timer was armed.
   */
  const compactThenNudge = (agent, state, token) => {
    const compaction = ctx.get('compaction')
    if (compaction === undefined) {
      ctx.logger.warn(`spur: 会话 ${String(agent.id)} 连续 ${state.idleNudges} 次提醒没有动作，但这一层没有压缩服务，跳过压缩`)
      state.idleNudges = 0
      queue(agent, state)
      return
    }
    void (async () => {
      try {
        const result = await compaction.compactNow(agent, compactionLifetime.signal)
        ctx.logger.info(`spur: 会话 ${String(agent.id)} 连续 ${state.idleNudges} 次提醒没有动作，已主动压缩${result === null ? '（没有可压缩范围）' : ''}`)
      } catch (error) {
        ctx.logger.warn(`spur: 主动压缩失败：${describeThrown(error)}`)
      }
      state.idleNudges = 0
      if (state.token !== token) return
      if (ctx.agents.get(agent.id) !== agent) return
      if (agent.status !== 'idle') return
      if (agent.inbox?.hasPending === true) return
      if (!needsNudge(agent)) return
      queue(agent, state)
    })()
  }

  /**
   * Build and queue the reminder, then account for it.
   * @param agent - target agent.
   * @param state - its session state.
   * @returns whether it was queued.
   */
  const queue = (agent, state) => {
    const attempt = state.nudges + 1
    try {
      agent.followup(nudgeMessage(
        reminderText(options, availableContextTools(ctx)),
        `保活提醒（第 ${attempt} 次）`,
      ))
    } catch (error) {
      ctx.logger.warn(`spur: 叫醒会话 ${String(agent.id)} 失败：${describeThrown(error)}`)
      return false
    }
    state.nudges = attempt
    state.idleNudges += 1
    state.lastNudgeAt = Date.now()
    state.recentNudges.push(Date.now())
    if (state.recentNudges.length > 3) state.recentNudges.shift()
    schedulePersist()
    ctx.logger.info(`spur: 已提醒会话 ${String(agent.id)}（第 ${attempt} 次）`)
    return true
  }

  /**
   * Arm the reminder timer for one stopped session.
   * @param agent - agent that just stopped.
   * @param state - its session state.
   */
  const arm = (agent, state) => armIn(agent, state, gapMs())

  /**
   * Arm the reminder timer with an explicit delay; the cool-down and the
   * "step aside" paths need their own wait instead of the interval.
   * @param agent - agent to wake later.
   * @param state - its session state.
   * @param delayMs - how long to wait before the check.
   */
  const armIn = (agent, state, delayMs) => {
    disarm(state)
    const token = state.token
    const timer = setTimeout(() => {
      state.timer = undefined
      try {
        deliver(agent, state, token)
      } catch (error) {
        ctx.logger.warn(`spur: 提醒计时器出错：${describeThrown(error)}`)
      }
    }, Math.max(0, delayMs))
    // A pending reminder must never keep the process alive.
    if (typeof timer.unref === 'function') timer.unref()
    state.timer = timer
  }

  /**
   * The cool-down after the switch was turned on. The reminder never fires
   * inside it: turning the plugin on is the one moment a user is most likely to
   * still be adjusting things, so a short reversal window beats an instant nudge.
   * @returns its length in milliseconds.
   */
  const graceMs = () => Math.max(0, options.enableGraceSeconds) * 1000

  /**
   * @param state - session state.
   * @returns how long is left of the cool-down, in milliseconds (0 when over).
   */
  const graceLeft = (state) => Math.max(0, state.enabledAt + graceMs() - Date.now())

  /**
   * The floor between two idle-triggered reminders. A session that keeps ending
   * short turns would otherwise be poked round after round without pause.
   * @returns its length in milliseconds.
   */
  const gapMs = () => Math.max(0, options.idleGapMinutes) * 60_000

  /**
   * @param state - session state.
   * @returns how long is left of that floor, in milliseconds (0 when over).
   */
  const gapLeft = (state) => Math.max(0, state.lastNudgeAt + gapMs() - Date.now())

  /**
   * React to a main agent going idle. This is the same transition the built-in
   * goal driver listens to, so the plugin is told about it instead of polling:
   * the reminder goes out on that transition, after the cool-down from `arm`
   * has passed.
   * @param agent - the agent whose status became idle.
   */
  const onIdle = (agent) => {
    if (isSubagent(agent.session)) return
    if (ctx.agents.get(agent.session.id) !== agent) return
    const state = stateFor(agent.session)
    // Only a turn that ended by itself counts: an aborted or failed turn means
    // the user (or the harness) stopped it, and poking it again would fight them.
    if (!state.lastTurnCompleted) return
    if (!needsNudge(agent)) return
    if (agent.inbox?.hasPending === true) return
    if (descendantsRunning(agent.session.id)) {
      arm(agent, state)
      return
    }
    if (graceLeft(state) > 0) {
      armIn(agent, state, graceLeft(state))
      return
    }
    // Two idle-triggered reminders stay at least one gap apart.
    if (gapLeft(state) > 0) {
      armIn(agent, state, gapLeft(state))
      return
    }
    // A turn that ends the instant it starts must not spin the reminder; fall
    // back to one interval when the last reminder is still fresh.
    if (Date.now() - state.lastNudgeAt < 1000) {
      arm(agent, state)
      return
    }
    state.probes += 1
    schedulePersist()
    if (options.compactAfterIdleNudges > 0 && state.idleNudges >= options.compactAfterIdleNudges) {
      compactThenNudge(agent, state, state.token)
      return
    }
    queue(agent, state)
  }

  /**
   * Drop a pending auto-shutdown check.
   * @param sessionId - session whose check is cancelled.
   */
  const cancelShutdown = (sessionId) => {
    const entry = shutdownDue.get(sessionId)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      shutdownDue.delete(sessionId)
    }
  }

  /**
   * Run the shutdown command now, once per halt label.
   * @param sessionId - the session that halted.
   * @param reason - the halt reason (`done`, `blocked`, or `paused`).
   */
  const runShutdown = (sessionId, reason) => {
    if (shutdownIssued.has(sessionId)) return
    shutdownDue.delete(sessionId)
    const grace = options.shutdownGraceSeconds
    const until = Date.now() + Math.max(1, grace) * 1000
    if (options.shutdownDryRun) {
      shutdownIssued.set(sessionId, { at: Date.now(), until })
      ctx.logger.info(`spur: [dry-run] 会话 ${sessionId} 已停用（${reason}），本应执行关机（宽限 ${grace} 秒）`)
      return
    }
    if (process.platform !== 'win32') {
      ctx.logger.warn('spur: 自动关机目前只在 Windows 上实现，本次跳过')
      return
    }
    shutdownIssued.set(sessionId, { at: Date.now(), until })
    execFile('shutdown', ['/s', '/t', String(grace), '/c', '会话保活提醒：任务已结束，按设置关机'], { windowsHide: true }, (error) => {
      if (error !== null) ctx.logger.warn(`spur: 执行关机命令失败：${describeThrown(error)}`)
      else ctx.logger.info(`spur: 已发起关机，宽限 ${grace} 秒（可用 shutdown /a 取消）`)
    })
  }

  /**
   * Cancel a shutdown that is still inside its grace period.
   * @param sessionId - the session whose shutdown is cancelled.
   * @returns whether a live shutdown was cancelled.
   */
  const cancelIssuedShutdown = (sessionId) => {
    const entry = shutdownIssued.get(sessionId)
    if (entry === undefined) return false
    shutdownIssued.delete(sessionId)
    if (Date.now() >= entry.until) return false
    if (options.shutdownDryRun) {
      ctx.logger.info(`spur: [dry-run] 已撤销会话 ${sessionId} 的关机`)
      return true
    }
    if (process.platform !== 'win32') return true
    execFile('shutdown', ['/a'], { windowsHide: true }, (error) => {
      if (error !== null) ctx.logger.warn(`spur: 撤销关机失败：${describeThrown(error)}`)
      else ctx.logger.info('spur: 已撤销关机')
    })
    return true
  }

  /**
   * Arm the auto-shutdown check after one halt label.
   * @param agent - the agent that replied with a halt label.
   */
  const scheduleShutdown = (agent) => {
    if (!options.shutdownOnHalt) return
    const sessionId = agent.session.id
    cancelShutdown(sessionId)
    const at = Date.now() + gapMs()
    const timer = setTimeout(() => {
      shutdownDue.delete(sessionId)
      const halt = halted.get(sessionId)
      if (halt === undefined) return
      if (!options.shutdownOnHalt) return
      runShutdown(sessionId, halt)
    }, gapMs())
    if (typeof timer.unref === 'function') timer.unref()
    shutdownDue.set(sessionId, { timer, at })
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      '回复保活提醒：在 reply 里写当前状态。',
      '全部任务都做完时填「已经完成所有任务」；确实进行不下去时填「进行不下去」；需要等用户回来才能继续时填「暂停」。',
      '这三种标签都会关闭本会话的提醒，直到用户在面板里重新打开；填任何其他内容都表示还没做完，提醒继续。',
      '只在回复正文里说「完成了」不会关掉提醒，要停就用本工具填标签。',
    ].join(''),
    parameters: {
      reply: {
        type: 'string',
        required: true,
        description: '当前状态标签；「已经完成所有任务」表示做完，「进行不下去」表示确实卡住，「暂停」表示等用户回来再做，其他内容表示还要继续。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          halted: { type: 'boolean', description: 'Whether the reminder for this session was switched off.' },
          reason: { type: 'string', description: 'The halt reason when halted: done or blocked.' },
          text: { type: 'string', description: 'What the plugin did with the label.' },
        },
        required: ['halted', 'text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${TOOL_NAME} 需要调用方智能体：这次调用没有携带 agent`)
      const sessionId = agent.session.id
      const label = normalizeLabel(args?.reply)
      const reason = HALT_LABELS.get(label)
      if (reason !== undefined) {
        halted.set(sessionId, reason)
        schedulePersist()
        const state = states.get(sessionId)
        if (state !== undefined) disarm(state)
        scheduleShutdown(agent)
      }
      return Promise.resolve({
        halted: reason !== undefined,
        ...reason === undefined ? {} : { reason },
        text: reason === 'done'
          ? '已记录「已经完成所有任务」：本会话的提醒关闭，直到用户在面板里重新打开。'
          : reason === 'blocked'
            ? '已记录「进行不下去」：本会话的提醒关闭，用户会在面板里看到卡住的原因类别，重新打开即恢复。'
            : reason === 'paused'
              ? '已记录「暂停」：本会话的提醒关闭，用户回来后重新打开开关即恢复。'
              : `已记录「${label === '' ? '（空）' : label}」：本会话的提醒继续。`,
      })
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Reply to the keep-alive reminder', kind: 'other' }),
  })

  /**
   * One committed event feed for every live session.
   */
  ctx.on('session/event', (session, event) => {
    try {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      if (isSubagent(session)) return
      const state = stateFor(session)
      switch (event.type) {
        case 'turn/start':
          stats.turnStart += 1
          state.token += 1
          state.lastTurnCompleted = false
          disarm(state)
          return
        case 'tool/result':
          // Real work happened, so the session is not stuck on its context.
          state.idleNudges = 0
          return
        case 'user/message': {
          if (event.data?.source?.kind !== 'user') return
          // A new user message starts a new task: the idle streak restarts. The
          // reminder counters stay cumulative for the panel's record.
          state.token += 1
          state.idleNudges = 0
          disarm(state)
          return
        }
        case 'turn/end': {
          stats.turnEnd += 1
          state.token += 1
          disarm(state)
          // The reminder is armed when the agent actually goes idle
          // (`agent/status`), not here: that is the same transition the built-in
          // goal driver reacts to, and it fires after the turn is really over.
          state.lastTurnCompleted = event.data?.reason?.kind === 'completed'
          return
        }
        default:
          return
      }
    } catch (error) {
      ctx.logger.warn(`spur: 会话事件处理失败：${describeThrown(error)}`)
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') {
      if (status === 'running') stats.statusRunning += 1
      return
    }
    stats.statusIdle += 1
    stats.lastStatusAt = Date.now()
    try {
      onIdle(agent)
    } catch (error) {
      ctx.logger.warn(`spur: 空闲通知处理失败：${describeThrown(error)}`)
    }
  })

  /**
   * Safety net for the events. The idle notification is the primary trigger, but
   * it can be missed: a plugin reload while the agent is already idle, a runtime
   * that does not emit the transition, a check that lost its timer. This sweep
   * re-arms or nudges any watched session that sits idle with nothing scheduled.
   * It is the only polling left, and it is deliberately slow.
   */
  ctx.effect(() => {
    const seconds = Number(options.watchdogSeconds)
    const period = Math.max(200, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000))
    const timer = setInterval(() => {
      stats.watchdogRuns += 1
      stats.lastWatchdogAt = Date.now()
      try {
        for (const agent of ctx.agents.list()) {
          if (isSubagent(agent.session)) continue
          const sessionId = agent.session.id
          if (!enabled.has(sessionId) || halted.has(sessionId)) continue
          if (agent.status !== 'idle') continue
          if (agent.inbox?.hasPending === true) continue
          const state = stateFor(agent.session)
          if (state.timer !== undefined) continue
          if (!needsNudge(agent)) continue
          if (descendantsRunning(sessionId)) continue
          if (graceLeft(state) > 0) {
            armIn(agent, state, graceLeft(state))
            continue
          }
          if (gapLeft(state) > 0) {
            armIn(agent, state, gapLeft(state))
            continue
          }
          state.probes += 1
          schedulePersist()
          stats.watchdogNudges += 1
          if (options.compactAfterIdleNudges > 0 && state.idleNudges >= options.compactAfterIdleNudges) {
            compactThenNudge(agent, state, state.token)
          } else {
            queue(agent, state)
          }
        }
      } catch (error) {
        ctx.logger.warn(`spur: 兜底巡检出错：${describeThrown(error)}`)
      }
    }, period)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'spur: watchdog')

  ctx.on('agent/created', ({ agent }) => {
    const state = stateFor(agent.session)
    const sessionId = agent.session.id
    if (halted.has(sessionId)) {
      // The halt survives a detach/attach, so the shutdown check must too.
      if (options.shutdownOnHalt && !shutdownIssued.has(sessionId)) scheduleShutdown(agent)
      return
    }
    if (!enabled.has(sessionId)) return
    // A page refresh detaches and re-creates the agent; the timer it owned is
    // gone, so a watched session gets a fresh cool-down instead of going quiet.
    if (agent.status === 'idle' && graceMs() > 0) armIn(agent, state, graceMs())
  })

  ctx.on('agent/disposed', ({ agent }) => {
    // Detaching an agent (page refresh, workspace switch) must not erase the
    // session's record: only the timers that point at this dead agent go away.
    const sessionId = agent.session.id
    const state = states.get(sessionId)
    if (state !== undefined) disarm(state)
    cancelShutdown(sessionId)
  })

  /**
   * Bound the per-session record so a long-lived host cannot grow forever.
   * Map iteration order is insertion order, so the oldest keys go first.
   */
  const pruneSessions = () => {
    const limit = 200
    while (states.size > limit) {
      const oldest = states.keys().next().value
      const state = states.get(oldest)
      if (state !== undefined) disarm(state)
      states.delete(oldest)
      enabled.delete(oldest)
      halted.delete(oldest)
      cancelShutdown(oldest)
      shutdownIssued.delete(oldest)
    }
    schedulePersist()
  }

  ctx.on('session/disposed', (session) => {
    // The right sidebar unloading a tab tears its session down and builds a new
    // one with the same id a moment later. That is not the user asking us to
    // forget the session, so only the timers go; the record stays keyed by id
    // and is pruned by count below instead of by lifecycle.
    const state = states.get(session.id)
    if (state !== undefined) disarm(state)
    cancelShutdown(session.id)
    pruneSessions()
  })

  ctx.effect(() => () => {
    // The final record write is synchronous and runs before the maps are
    // cleared, so a reload hands the next instance the state it had.
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistRecords()
    for (const state of states.values()) disarm(state)
    states.clear()
    enabled.clear()
    halted.clear()
    for (const entry of shutdownDue.values()) clearTimeout(entry.timer)
    shutdownDue.clear()
    shutdownIssued.clear()
    compactionLifetime.abort()
  })

  /**
   * One panel snapshot for a session.
   * @param sessionId - session the panel is showing, when known.
   * @returns the JSON the client renders.
   */
  const snapshot = (sessionId) => {
    const agent = sessionId === undefined ? undefined : ctx.agents.get(sessionId)
    const state = sessionId === undefined ? undefined : states.get(sessionId)
    return {
      config: publicConfig(options),
      defaults: { ...DEFAULT_OPTIONS },
      limits: LIMITS,
      tools: availableContextTools(ctx),
      storage: settingsPath(ctx) !== undefined,
      // The exact message the next reminder would deliver, so the panel can show
      // what the model will read instead of describing it.
      reminder: reminderText(options, availableContextTools(ctx)),
      session: sessionId === undefined ? null : {
        id: sessionId,
        live: agent !== undefined,
        status: agent?.status ?? 'absent',
        enabled: enabled.has(sessionId),
        halted: halted.get(sessionId) ?? null,
        nudges: state?.nudges ?? 0,
        probes: state?.probes ?? 0,
        recentNudges: state?.recentNudges ?? [],
        armed: state?.timer !== undefined,
        shutdownAt: shutdownDue.get(sessionId)?.at ?? null,
        shutdownIssued: shutdownIssued.has(sessionId),
        shutdownDeadline: shutdownIssued.get(sessionId)?.until ?? null,
      },
    }
  }

  const connection = ctx.get('connection')
  if (connection !== undefined) {
    const routes = [
      connection.fetch.register({
        path: STATE_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined
          return Promise.resolve(jsonResponse(snapshot(sessionId)))
        },
      }),
      connection.fetch.register({
        path: ACTION_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400)
          }
          const action = body?.action
          if (action === 'preview') {
            const raw = body?.config
            const next = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
              ? resolveOptions(ctx, raw, options)
              : options
            return jsonResponse({ ok: true, reminder: reminderText(next, availableContextTools(ctx)) })
          }
          if (action === 'config') {
            const raw = body?.config
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
              return jsonResponse({ ok: false, error: 'config 必须是对象' }, 400)
            }
            Object.assign(options, resolveOptions(ctx, raw, options))
            try {
              writeSettings(ctx, publicConfig(options))
            } catch (error) {
              return jsonResponse({ ok: false, error: describeThrown(error) }, 500)
            }
            // Turning the shutdown option off also drops checks already armed.
            if (!options.shutdownOnHalt) {
              for (const entry of shutdownDue.values()) clearTimeout(entry.timer)
              shutdownDue.clear()
            }
            return jsonResponse({ ok: true, ...snapshot(body?.sessionId ?? undefined) })
          }
          if (action === 'session') {
            const sessionId = body?.sessionId
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
              return jsonResponse({ ok: false, error: '缺少 sessionId' }, 400)
            }
            if (body?.enabled === true) {
              // Turning it on by hand also clears whatever label halted it,
              // and aborts a shutdown still inside its grace period.
              enabled.add(sessionId)
              halted.delete(sessionId)
              cancelShutdown(sessionId)
              cancelIssuedShutdown(sessionId)
              // The cool-down starts now: turning it on must not wake the model
              // in the same breath, because the user is often still setting up.
              const live = ctx.agents.get(sessionId)
              if (live !== undefined) {
                const state = stateFor(live.session)
                state.enabledAt = Date.now()
                // With a cool-down configured, the first check happens when it is
                // over; without one there is nothing to schedule and the next idle
                // transition (or the watchdog) takes it from here.
                if (graceMs() > 0) armIn(live, state, graceMs())
              }
              schedulePersist()
            } else {
              enabled.delete(sessionId)
              const state = states.get(sessionId)
              if (state !== undefined) disarm(state)
              schedulePersist()
            }
            return jsonResponse({ ok: true, ...snapshot(sessionId) })
          }
          if (action === 'nudge') {
            const sessionId = body?.sessionId
            const agent = typeof sessionId === 'string' ? ctx.agents.get(sessionId) : undefined
            if (agent === undefined) return jsonResponse({ ok: false, error: '这个会话当前不在运行' }, 404)
            if (!enabled.has(agent.session.id)) return jsonResponse({ ok: false, error: '本会话没有启用保活提醒，先在面板里打开' }, 409)
            const halt = halted.get(agent.session.id)
            if (halt !== undefined) {
              return jsonResponse({
                ok: false,
                error: halt === 'blocked'
                  ? '主智能体已声明进行不下去，提醒已关闭；要恢复请在面板里重新打开'
                  : halt === 'paused'
                    ? '主智能体已声明暂停，提醒已关闭；要恢复请在面板里重新打开'
                    : '主智能体已声明全部完成，提醒已关闭；要恢复请在面板里重新打开',
              }, 409)
            }
            // A running agent is already working; a queued reminder would only
            // land on a turn the user is watching.
            if (agent.status !== 'idle') return jsonResponse({ ok: false, error: '会话正在运行，等它停下来再提醒' }, 409)
            const state = stateFor(agent.session)
            if (!queue(agent, state)) {
              return jsonResponse({ ok: false, error: '提醒没能发出' }, 500)
            }
            return jsonResponse({ ok: true, ...snapshot(agent.session.id) })
          }
          if (action === 'shutdown-cancel') {
            const sessionId = body?.sessionId
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
              return jsonResponse({ ok: false, error: '缺少 sessionId' }, 400)
            }
            const entry = shutdownIssued.get(sessionId)
            if (entry === undefined) {
              return jsonResponse({ ok: false, error: '没有待撤销的关机' }, 409)
            }
            if (Date.now() >= entry.until) {
              return jsonResponse({ ok: false, error: '宽限期已经过去，撤销不了' }, 409)
            }
            cancelIssuedShutdown(sessionId)
            return jsonResponse({ ok: true, ...snapshot(sessionId) })
          }
          return jsonResponse({ ok: false, error: `未知动作 ${String(action)}` }, 400)
        },
      }),
    ]
    ctx.effect(() => () => Promise.allSettled(routes.map(dispose => dispose())).then(() => undefined))
  }
}
