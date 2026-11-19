/**
 * 会话保活提醒插件的界面半边：在右侧工具区注册一个「会话保活提醒」页签，页签里是配置面板。
 *
 * 面板通过两条路由跟宿主半边打交道：
 * - GET  `/api/spur.state?sessionId=...`  读当前设置、上下文工具可用性、本会话状态
 * - POST `/api/spur.action`              `{ action: 'config' | 'session' | 'nudge', ... }`
 *
 * 页面里的开关直接作用于当前会话：关掉本会话的保活提醒之后，宿主不再给它排提醒，
 * 并且把这个会话智能体作用域里的系统提示词那一节撤掉。
 *
 * 这个文件不进构建流程：它是浏览器模块表里注册的一段普通 ESM，React 由
 * `require('react')` 从模块表拿到，界面只用宿主主题变量上色。
 */
window.__ModuleLoader__.load({
  id: '@kingzyt/dsh-spur',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'spur'
    const PANEL_ID = 'spur-panel'
    const PANEL_KIND = 'spur'

    const zh = {
      'panel.title': '会话保活提醒',
      'panel.description': '任务没做完就停下时，隔一段时间把会话叫回来继续做。',
      'panel.subtitle': '任务没做完就停下时，隔一段时间把会话叫回来继续做；右侧面板只管当前会话。',
      'session.title': '本会话',
      'session.state.running': '运行中',
      'session.state.idle': '空闲',
      'session.state.absent': '未加载',
      'session.enabled': '在本会话启用保活提醒',
      'session.enabledHint': '默认关闭。打开之后，每个正常结束的回合都会在间隔之后收到一次提醒，直到主智能体声明全部完成或你关掉它。',
      'session.disabledHint': '本会话没有启用：不会收到任何提醒。',
      'session.doneHint': '主智能体已声明全部完成，提醒已关闭；重新打开开关可以恢复。',
      'session.blockedHint': '主智能体已声明进行不下去，提醒已关闭；重新打开开关可以恢复。',
      'session.pausedHint': '主智能体已声明暂停、等你回来再继续，提醒已关闭；重新打开开关可以恢复。',
      'session.shutdown': '已排定关机：约 {minutes} 分钟后检查一次，到点仍停着就执行。',
      'session.shutdownCountdown': '关机将在 {seconds} 秒后执行；点右边可以撤销。',
      'session.shutdownIssued': '已发起关机：宽限期内可以用 shutdown /a 取消。',
      'session.cancelShutdown': '撤销关机',
      'session.shutdownCancelled': '已撤销关机。',
      'session.runningHint': '会话正在跑，保活提醒不会打扰它；等它停下来，再按间隔排下一次提醒。',
      'session.armed': '已排定：等它下次空闲时按流程检查。',
      'session.nudgeNow': '立即提醒一次',
      'session.nudgeQueued': '已排入下一次提醒。',
      'session.probes': '探查 {probes} 次 · 提醒 {nudges} 次',
      'session.recent': '最近提醒：{times}',
      'session.noRecent': '还没有提醒过。',
      'params.title': '全局参数',
      'params.hint': '改完自动保存并立即生效，不需要重启。',
      'params.floor': '预算焦虑门槛（%）',
      'params.floorHint': '提醒里告诉模型：到这个百分比以上才需要担心预算。这是「不用焦虑」的门槛，不是压缩许可——流程要求压缩时照流程压。',
      'params.gap': '两条提醒之间至少隔（分钟）',
      'params.gapHint': '空闲触发时，两条提醒至少间隔这么久：回合再短也不会连着催。默认 2 分钟。',
      'params.grace': '开启后的反悔期（秒）',
      'params.graceHint': '打开会话开关后先等这么久再开始提醒，留出改设置、反悔的时间。默认 30 秒。',
      'params.compactNudges': '连续几次提醒没动静就主动压缩',
      'params.compactNudgesHint': '连续 N 次提醒之间一次工具都没跑，就认为会话被上下文压住了：插件先主动压缩一次，再把它叫醒。0 表示不压缩。',
      'params.shutdown': '任务结束后自动关机',
      'params.shutdownHint': '主智能体声明「已经完成所有任务」或「进行不下去」之后，隔一个提醒间隔检查一次；那时开关还开着、标签还在就执行关机。Windows 上先给 60 秒宽限，可用 shutdown /a 取消。默认关闭。',
      'reminder.title': '发给 AI 的提醒',
      'reminder.hint': '这是到点时会发给会话的消息原文（跟随已保存的设置与上下文工具）。',
      'reminder.draft': '上面是未保存草稿的预览；约半秒后自动保存，之后按这段发送。',
      'reminder.empty': '（当前设置下这条提醒只有开头一句）',
      'params.autoTask': '自动任务模式（追加多步任务提示）',
      'params.autoTaskHint': '打开后每条提醒末尾追加下面这段文字。',
      'params.autoTaskText': '追加的提示词',
      'params.autoTaskTextHint': '原样追加到每条提醒末尾；改完自动生效，「恢复默认」换回内置版本。',
      'save': '保存',
      'saved': '已保存。',
      'reset': '恢复默认',
      'loading': '正在读取设置…',
      'loadFailed': '读取设置失败：{error}',
      'saveFailed': '保存失败：{error}',
      'storageMissing': '这个部署没有 profile 目录，设置只在本次运行内有效。',
      'tools.missing': '本会话没有上下文查询/压缩工具，提醒里不会提压缩。',
      'tools.partial': '只装了上下文查询工具，提醒里不会提压缩。',
    }

    const en = {
      'panel.title': 'Session keep-alive',
      'panel.description': 'Calls an idle session back to unfinished work after a while.',
      'panel.subtitle': 'Calls an idle session back to unfinished work after a while. This panel only affects the current session.',
      'session.title': 'This session',
      'session.state.running': 'Running',
      'session.state.idle': 'Idle',
      'session.state.absent': 'Not loaded',
      'session.enabled': 'Enable the keep-alive reminder in this session',
      'session.enabledHint': 'Off by default. Once on, every completed turn gets a reminder after the interval until the main agent says all tasks are done, or you turn it off.',
      'session.disabledHint': 'The keep-alive reminder is off in this session: no reminders at all.',
      'session.doneHint': 'The main agent said all tasks are done, so reminders stopped; turn the switch back on to resume.',
      'session.blockedHint': 'The main agent said it cannot continue, so reminders stopped; turn the switch back on to resume.',
      'session.pausedHint': 'The main agent paused until you are back, so reminders stopped; turn the switch back on to resume.',
      'session.shutdown': 'Shutdown scheduled: checks once in about {minutes} min and powers off if still halted.',
      'session.shutdownCountdown': 'Shutting down in {seconds}s; use the button to cancel.',
      'session.shutdownIssued': 'Shutdown issued: run shutdown /a within the grace period to cancel.',
      'session.cancelShutdown': 'Cancel shutdown',
      'session.shutdownCancelled': 'Shutdown cancelled.',
      'session.runningHint': 'The session is running; the keep-alive reminder keeps out of the way and re-arms after it stops.',
      'session.armed': 'Scheduled: checks again when the session next goes idle.',
      'session.nudgeNow': 'Nudge now',
      'session.nudgeQueued': 'Queued for the next turn.',
      'session.probes': 'Probes: {probes} · reminders: {nudges}',
      'session.recent': 'Recent reminders: {times}',
      'session.noRecent': 'No reminders yet.',
      'params.title': 'Global settings',
      'params.hint': 'Changes save themselves and apply immediately.',
      'params.floor': 'Budget worry threshold (%)',
      'params.floorHint': 'The reminder tells the model: only worry about the budget from this occupancy on. It is a "stop worrying" line, not a permission gate — a flow that compacts still compacts.',
      'params.gap': 'Minimum gap between reminders (minutes)',
      'params.gapHint': 'Idle-triggered reminders never come closer than this, so short turns cannot cause a burst. Default: 2 minutes.',
      'params.grace': 'Cool-down after switching it on (seconds)',
      'params.graceHint': 'After you turn the session switch on, the plugin waits this long before the first reminder, leaving time to change settings or change your mind. Default: 30 seconds.',
      'params.compactNudges': 'Compact after N reminders without progress',
      'params.compactNudgesHint': 'After N reminders in a row without a single tool run, the plugin compacts the session itself and then wakes it. 0 disables it.',
      'params.shutdown': 'Power off after the task ends',
      'params.shutdownHint': 'After the main agent reports done or blocked, one gap later the plugin powers the host off if the label is still in place. Windows gets a 60-second grace period; run shutdown /a to cancel. Off by default.',
      'reminder.title': 'Message sent to the AI',
      'reminder.hint': 'The exact text the next reminder delivers, following the saved settings and the registered context tools.',
      'reminder.draft': 'The text above previews the unsaved draft; it saves itself in about half a second and is sent from then on.',
      'reminder.empty': '(Under the current settings this reminder is just the opening line.)',
      'params.autoTask': 'Auto-task mode (append the multi-step instructions)',
      'params.autoTaskHint': 'When on, every reminder carries the text below at its end.',
      'params.autoTaskText': 'Instructions to append',
      'params.autoTaskTextHint': 'Appended verbatim to every reminder; edits apply automatically and "Reset to defaults" restores the built-in text.',
      'save': 'Save',
      'saved': 'Saved.',
      'reset': 'Reset to defaults',
      'loading': 'Loading settings…',
      'loadFailed': 'Could not load settings: {error}',
      'saveFailed': 'Could not save: {error}',
      'storageMissing': 'This deployment has no profile directory, so settings live only for this run.',
      'tools.missing': 'This session has no context tools, so reminders will not mention compaction.',
      'tools.partial': 'Only the context reader is installed, so reminders will not mention compaction.',
    }

    /** Translate with the flat `{name}` placeholders the locale service uses. */
    function format(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        (values !== null && values !== undefined && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match))
    }

    const color = {
      label: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      bg: 'var(--dsw-alias-bg-base)',
      card: 'var(--dsw-alias-bg-layer-1)',
      inset: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px 24px', color: color.label, fontSize: 13, lineHeight: 1.5, overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
      section: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, border: `1px solid ${color.border}`, background: color.card },
      sectionTitle: { fontSize: 12, fontWeight: 600, letterSpacing: 0.4, color: color.muted, textTransform: 'uppercase' },
      row: { display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' },
      grow: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      label: { fontSize: 13, color: color.label },
      hint: { fontSize: 12, color: color.muted },
      input: { width: 88, padding: '4px 8px', borderRadius: 6, border: `1px solid ${color.borderStrong}`, background: color.inset, color: color.label, fontSize: 13, textAlign: 'right' },
      switchButton: (on) => ({
        width: 40, height: 22, borderRadius: 11, padding: 2, border: 'none', cursor: 'pointer',
        background: on ? color.brand : color.idle, display: 'flex', alignItems: 'center',
        justifyContent: on ? 'flex-end' : 'flex-start', boxSizing: 'border-box', flex: '0 0 auto',
      }),
      knob: { width: 18, height: 18, borderRadius: 9, background: '#fff' },
      button: (primary, disabled) => ({
        padding: '5px 12px', borderRadius: 6, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
        border: primary ? 'none' : `1px solid ${color.borderStrong}`,
        background: primary ? color.brand : 'transparent',
        color: primary ? '#fff' : color.label,
        opacity: disabled ? 0.5 : 1,
      }),
      footer: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      status: (tone) => ({ fontSize: 12, color: tone === 'error' ? color.error : color.muted, flex: 1, minWidth: 0 }),
      pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.65, margin: 0, padding: 10, borderRadius: 8, background: color.inset, border: `1px solid ${color.border}`, color: color.label },
      column: { display: 'flex', flexDirection: 'column', gap: 4 },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: 140, padding: 10, borderRadius: 8, border: `1px solid ${color.border}`, background: color.inset, color: color.label, fontFamily: 'inherit', fontSize: 12, lineHeight: 1.6, resize: 'vertical' },
      badge: (tone) => ({ fontSize: 11, padding: '1px 8px', borderRadius: 999, color: tone === 'warn' ? color.warn : color.muted, border: `1px solid ${tone === 'warn' ? color.warn : color.border}` }),
    }

    /** One labelled switch row. */
    function Switch(props) {
      const { label, hint, checked, disabled, onChange } = props
      return h('div', { style: styles.row },
        h('div', { style: styles.grow },
          h('div', { style: styles.label }, label),
          hint ? h('div', { style: styles.hint }, hint) : null),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled: disabled === true,
          onClick: () => { onChange(!checked) },
          style: { ...styles.switchButton(checked), opacity: disabled === true ? 0.5 : 1 },
        }, h('span', { style: styles.knob })))
    }

    /** One labelled number row. */
    function NumberField(props) {
      const { label, hint, value, limit, disabled, onChange } = props
      const min = limit === undefined ? undefined : limit.min
      const max = limit === undefined ? undefined : limit.max
      const step = limit === undefined ? undefined : limit.step
      return h('label', { style: styles.row },
        h('span', { style: styles.grow },
          h('span', { style: styles.label }, label),
          hint ? h('span', { style: styles.hint }, hint) : null),
        h('input', {
          type: 'number',
          value: value === undefined || value === null ? '' : String(value),
          min, max, step,
          disabled: disabled === true,
          style: { ...styles.input, opacity: disabled === true ? 0.5 : 1 },
          onChange: (event) => {
            const next = Number(event.target.value)
            onChange(Number.isFinite(next) ? next : undefined)
          },
        }))
    }

    /** One labelled multi-line text block. */
    function TextArea(props) {
      const { label, hint, value, disabled, onChange } = props
      return h('label', { style: styles.column },
        h('span', { style: styles.label }, label),
        hint ? h('span', { style: styles.hint }, hint) : null,
        h('textarea', {
          value: value === undefined || value === null ? '' : String(value),
          rows: 8,
          spellCheck: false,
          disabled: disabled === true,
          style: { ...styles.textarea, opacity: disabled === true ? 0.5 : 1 },
          onChange: (event) => onChange(event.target.value),
        }))
    }

    /** A pending auto-save; the timer outlives a panel remount on purpose. */
    let autoSaveTimer

    /**
     * Unsaved settings survive a remount (tab switch) and a page reload: the
     * panel keeps its draft in localStorage and merges it back over the server
     * config, so an edit made before 保存 is never silently thrown away.
     */
    const DRAFT_KEY = 'dsh.spur.draft.v1'
    const readDraft = () => {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(DRAFT_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }
    const writeDraft = (draft) => {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      } catch {
        // A full or disabled storage only costs the draft, never the panel.
      }
    }
    const clearDraft = () => {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.removeItem(DRAFT_KEY)
      } catch {
        // Same as above: no draft to clear.
      }
    }

    /** The right-side panel body. */
    function SpurPanel(props) {
      const { t, sessionId } = props
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [now, setNow] = React.useState(Date.now())
      // Hooks must run in the same order on every render, so the live Session
      // selector is called here — before the loading early-return below. Calling
      // it after that return made the second render use one more hook than the
      // first and crashed the slot entry with React #310.
      const useSession = typeof props.useSession === 'function' ? props.useSession : () => false
      const running = useSession((snapshot) => snapshot !== undefined && snapshot.running === true) === true

      const shutdownPending = state?.session?.shutdownIssued === true
        && typeof state?.session?.shutdownDeadline === 'number'
      const shutdownDeadline = shutdownPending ? state.session.shutdownDeadline : null
      React.useEffect(() => {
        if (!shutdownPending) return undefined
        const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
        return () => { clearInterval(timer) }
      }, [shutdownPending, shutdownDeadline])

      // The reminder preview follows the draft, not only the saved config: a
      // switch that does not move the text under it reads as broken. The host
      // renders the text, so the panel never duplicates that template.
      const [preview, setPreview] = React.useState(null)
      const draftKey = draft === null ? '' : JSON.stringify(draft)
      const savedKey = state === null || state.config === undefined ? '' : JSON.stringify(state.config)
      React.useEffect(() => {
        if (draftKey === '' || draftKey === savedKey) {
          setPreview(null)
          return undefined
        }
        let live = true
        const timer = setTimeout(() => {
          fetch('/api/spur.action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'preview', sessionId, config: draft }),
          })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((body) => { if (live && body?.ok === true && typeof body.reminder === 'string') setPreview(body.reminder) })
            .catch(() => {})
        }, 150)
        return () => { live = false; clearTimeout(timer) }
      }, [draftKey, savedKey, draft, sessionId])

      /**
       * Take a fresh server snapshot. `resetDraft` is only true after a save or
       * a first load: a session-switch action must not discard unsaved settings.
       * @param next - the snapshot the action returned.
       * @param resetDraft - replace the draft with the saved config.
       */
      const applyState = (next, resetDraft = false) => {
        setState(next)
        if (resetDraft) setDraft(next.config)
      }

      /** Change one draft field and apply it before the panel can be remounted. */
      const updateDraft = (next) => {
        setDraft(next)
        writeDraft(next)
        scheduleSave(next)
      }

      const load = React.useCallback(async () => {
        const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
        const response = await fetch(`/api/spur.state${query}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = await response.json()
        setState(next)
        // A draft left in storage is the user's unsaved work: keep it on top of
        // the saved config instead of silently reverting to the file, and push
        // it to the host so the panel's state is what the model will receive.
        const stored = readDraft()
        const known = stored !== null && Object.keys(next.config ?? {}).some((key) => stored[key] !== undefined)
        const merged = known ? { ...next.config, ...stored } : next.config
        setDraft(merged)
        if (known && JSON.stringify(merged) !== JSON.stringify(next.config)) scheduleSave(merged)
      }, [sessionId])

      React.useEffect(() => {
        let live = true
        load().catch((error) => { if (live) setNotice({ tone: 'error', text: format(t('loadFailed'), { error: String(error.message ?? error) }) }) })
        return () => { live = false }
      }, [load, t])

      const post = React.useCallback(async (action) => {
        const response = await fetch('/api/spur.action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...action, sessionId }),
        })
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
        if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      }, [sessionId])

      /**
       * Apply a change without waiting for the save button. The timer lives in
       * the module, not the component, so switching the tab does not cancel a
       * save that is still pending — that was one way a switch silently did
       * nothing to the message the model actually received.
       * @param next - the settings object to persist.
       */
      const scheduleSave = (next) => {
        if (autoSaveTimer !== undefined) clearTimeout(autoSaveTimer)
        autoSaveTimer = setTimeout(() => {
          autoSaveTimer = undefined
          post({ action: 'config', config: next })
            .then((body) => {
              setState(body)
              clearDraft()
            })
            .catch((error) => {
              setNotice({ tone: 'error', text: format(t('saveFailed'), { error: String(error.message ?? error) }) })
            })
        }, 500)
      }

      if (state === null || draft === null) {
        return h('div', { style: styles.root }, h('div', { style: styles.hint }, t('loading')))
      }

      const config = state.config
      const session = state.session
      const live = session !== null && session.live === true
      // 'done' or 'blocked': the main agent turned the reminder off by itself.
      const halted = session === null ? null : (session.halted ?? null)
      // The switch is on only while the session really is being watched.
      const on = session !== null && session.enabled === true && halted === null
      const probes = session?.probes ?? 0
      const nudges = session?.nudges ?? 0
      const recent = Array.isArray(session?.recentNudges) ? session.recentNudges : []
      // Live from the Session snapshot, not from the last fetch; `running` was
      // read before the early return so the hook order stays stable.

      const run = async (task) => {
        setBusy(true)
        setNotice(null)
        try {
          await task()
        } catch (error) {
          setNotice({ tone: 'error', text: format(t('saveFailed'), { error: String(error.message ?? error) }) })
        } finally {
          setBusy(false)
        }
      }

      const toggleSession = (next) => run(async () => {
        const body = await post({ action: 'session', enabled: next })
        applyState(body)
        setNotice(null)
      })

      const nudgeNow = () => run(async () => {
        const next = await post({ action: 'nudge' })
        applyState(next)
        setNotice({ tone: 'ok', text: t('session.nudgeQueued') })
      })

      const cancelShutdown = () => run(async () => {
        const next = await post({ action: 'shutdown-cancel' })
        applyState(next)
        setNotice({ tone: 'ok', text: t('session.shutdownCancelled') })
      })

      const setField = (key) => (value) => { updateDraft({ ...draft, [key]: value }) }

      const tools = state.tools ?? { usage: false, compact: false }
      const toolHint = tools.compact && tools.usage ? null : (tools.usage ? t('tools.partial') : t('tools.missing'))
      const statusText = !live ? t('session.state.absent') : running ? t('session.state.running') : t('session.state.idle')
      const canNudge = live && on && !running
      const cancelledShutdown = session !== null && session.shutdownIssued === true
      const remainingSeconds = shutdownPending ? Math.max(0, Math.ceil((session.shutdownDeadline - now) / 1_000)) : 0
      const shutdownLive = shutdownPending && remainingSeconds > 0

      return h('div', { style: styles.root },
        h('div', { style: styles.grow },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('panel.title')),
          h('div', { style: styles.hint }, t('panel.subtitle'))),

        h('div', { style: styles.section },
          h('div', { style: { ...styles.row, justifyContent: 'flex-start' } },
            h('div', { style: styles.sectionTitle }, t('session.title')),
            h('span', { style: styles.badge(on ? 'muted' : 'warn') }, on ? 'ON' : 'OFF'),
            h('span', { style: styles.hint }, statusText)),
          h(Switch, {
            label: t('session.enabled'),
            hint: t('session.enabledHint'),
            checked: on,
            disabled: busy || !live,
            onChange: toggleSession,
          }),
          halted === 'done' ? h('div', { style: styles.hint }, t('session.doneHint')) : null,
          halted === 'blocked' ? h('div', { style: styles.hint }, t('session.blockedHint')) : null,
          halted === 'paused' ? h('div', { style: styles.hint }, t('session.pausedHint')) : null,
          halted === null && !on ? h('div', { style: styles.hint }, t('session.disabledHint')) : null,
          shutdownLive
            ? h('div', { style: styles.hint }, format(t('session.shutdownCountdown'), { seconds: remainingSeconds }))
            : null,
          shutdownLive
            ? h('div', { style: styles.row },
              h('div', { style: styles.grow }),
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: cancelShutdown,
                style: styles.button(true, busy),
              }, t('session.cancelShutdown')))
            : null,
          cancelledShutdown && !shutdownLive
            ? h('div', { style: styles.hint }, t('session.shutdownIssued'))
            : session !== null && session.shutdownAt !== null && session.shutdownAt !== undefined
              ? h('div', { style: styles.hint }, format(t('session.shutdown'), { minutes: draft.idleGapMinutes }))
              : null,
          running ? h('div', { style: styles.hint }, t('session.runningHint')) : null,
          !running && on && session.armed === true
            ? h('div', { style: styles.hint }, t('session.armed'))
            : null,
          h('div', { style: styles.hint }, format(t('session.probes'), { probes, nudges })),
          h('div', { style: styles.hint }, recent.length > 0
            ? format(t('session.recent'), { times: recent.map((at) => new Date(at).toTimeString().slice(0, 8)).join(' / ') })
            : t('session.noRecent')),
          h('div', { style: styles.row },
            h('div', { style: styles.grow }),
            h('button', {
              type: 'button',
              disabled: busy || !canNudge,
              onClick: nudgeNow,
              style: styles.button(false, busy || !canNudge),
            }, t('session.nudgeNow')))),

        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('params.title')),
          h(NumberField, { label: t('params.floor'), hint: t('params.floorHint'), value: draft.compactFloorPercent, limit: state.limits?.compactFloorPercent, disabled: busy, onChange: setField('compactFloorPercent') }),
          h(NumberField, { label: t('params.compactNudges'), hint: t('params.compactNudgesHint'), value: draft.compactAfterIdleNudges, limit: state.limits?.compactAfterIdleNudges, disabled: busy, onChange: setField('compactAfterIdleNudges') }),
          h(NumberField, { label: t('params.gap'), hint: t('params.gapHint'), value: draft.idleGapMinutes, limit: state.limits?.idleGapMinutes, disabled: busy, onChange: setField('idleGapMinutes') }),
          h(NumberField, { label: t('params.grace'), hint: t('params.graceHint'), value: draft.enableGraceSeconds, limit: state.limits?.enableGraceSeconds, disabled: busy, onChange: setField('enableGraceSeconds') }),
          h(Switch, {
            label: t('params.shutdown'),
            hint: t('params.shutdownHint'),
            checked: draft.shutdownOnHalt === true,
            disabled: busy,
            onChange: (value) => { updateDraft({ ...draft, shutdownOnHalt: value }) },
          }),
          h(Switch, {
            label: t('params.autoTask'),
            hint: t('params.autoTaskHint'),
            checked: draft.autoTaskMode === true,
            disabled: busy,
            onChange: (value) => { updateDraft({ ...draft, autoTaskMode: value }) },
          }),
          h(TextArea, {
            label: t('params.autoTaskText'),
            hint: t('params.autoTaskTextHint'),
            value: draft.autoTaskHint,
            disabled: busy,
            onChange: (value) => { updateDraft({ ...draft, autoTaskHint: value }) },
          }),
          h('div', { style: styles.hint }, t('params.hint'))),

        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('reminder.title')),
          h('div', { style: styles.pre }, String(preview ?? state.reminder ?? '')),
          h('div', { style: styles.hint }, t(preview === null ? 'reminder.hint' : 'reminder.draft'))),

        toolHint === null ? null : h('div', { style: styles.hint }, toolHint),
        state.storage === false ? h('div', { style: styles.hint }, t('storageMissing')) : null,

        h('div', { style: styles.footer },
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => { updateDraft({ ...state.defaults }) },
            style: styles.button(false, busy),
          }, t('reset')),
          notice === null ? null : h('div', { style: styles.status(notice.tone) }, notice.text)),
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'spur: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PANEL_ID,
          kind: PANEL_KIND,
          title: () => t('panel.title'),
          guide: [{
            id: 'spur',
            order: 40,
            title: () => t('panel.title'),
            description: () => t('panel.description'),
          }],
        }), 'spur: sidebar tab type')
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANEL_ID,
          locale: NS,
        }, SpurPanel))
      },
    }
  },
})
