'use strict'
// Solitaire for cc-cockpit: classic seven-column patience in a panel, to play while Claude works. The game lives here
// in the host (lib/controller.js), one per project window: the panel page only draws what it is sent and posts the
// person's moves, so closing, hiding or reopening the panel never loses or unpauses a game.
//
// Harmless by design: no exec, no network, no secrets, no overlays, and nothing is ever typed into or sent to a
// session. Its only calls on Claude tabs are reading the window's list (ctx.sessions.list / onChange) for the pause
// and `ctx.sessions.focus` for the person's own Go to the tab click.

const { createController } = require('../lib/controller.js')
const { isDraw, DRAWS } = require('../lib/rules.js')

const PANEL = 'solitaire'
const DRAW_KEY = 'draw'
const WON_KEY = (draw) => `won:${draw}`
const BEST_KEY = (draw) => `best:${draw}`
/** Finish sends one card home this often, so the person sees the cards go rather than a jump to the win. */
const FINISH_MS = 70

let disposers = []

exports.activate = (ctx) => {
  // Records and the draw mode are app-wide (every project window plays the same records); an app without
  // ctx.appStorage keeps them per project instead.
  const store = typeof ctx.appStorage === 'object' && ctx.appStorage !== null ? ctx.appStorage : ctx.storage
  const controller = createController()
  const fourOf = (settings) => !!(settings && settings.app && settings.app.fourColour === true)
  controller.setFour(fourOf(ctx.settings))

  // The title bar: New game, Undo and the draw switch as icon buttons, the draw mode and the moves as its muted
  // text. Undo is greyed out while there is nothing to undo or the game is paused (a disabled action never reaches
  // onAction). The draw button shows the mode it switches to.
  let headerKey = ''
  function header() {
    const draw = controller.draw()
    const moves = controller.moves()
    const meta = `Draw ${draw}${moves > 0 ? ` · ${moves} ${moves === 1 ? 'move' : 'moves'}` : ''}`
    const undoOff = !controller.canUndo() || controller.isPaused()
    const key = `${meta}|${undoOff}`
    if (key === headerKey) return
    headerKey = key
    const other = draw === 1 ? 3 : 1
    try {
      ctx.panels.header(PANEL, {
        meta,
        actions: [
          { id: 'new', icon: 'refresh', title: 'New game (N)' },
          { id: 'undo', icon: 'icons/undo.svg', title: 'Undo (U)', disabled: undoOff },
          { id: 'draw', icon: `icons/draw${other}.svg`, title: `Switch to Draw ${other} (deals a new game)` },
        ],
      })
    } catch (err) {
      ctx.log.warn(`could not set the panel header: ${err && err.message}`)
    }
  }
  const push = () => {
    header()
    ctx.panels.post(PANEL, { state: controller.snapshot() })
  }
  header()
  /** To the one page that asked (`from.view`), or to every view when the app gave none. */
  const answer = (message, from) =>
    from && typeof from.view === 'string' ? ctx.panels.post(PANEL, message, { view: from.view }) : ctx.panels.post(PANEL, message)
  const viewOf = (from) => (from && typeof from.view === 'string' ? from.view : 'desktop')
  let picked = false // the person chose a draw mode before the stored one was read: theirs wins

  async function load() {
    const won = {}
    const best = {}
    for (const d of DRAWS) {
      won[d] = await store.get(WON_KEY(d))
      best[d] = await store.get(BEST_KEY(d))
    }
    controller.setStats({ won, best })
    const draw = await store.get(DRAW_KEY)
    // Only a deal nobody has touched yet is swapped for the stored mode.
    if (!picked && isDraw(draw) && draw !== controller.draw() && controller.untouched()) controller.act({ act: 'new', draw })
    header()
  }
  // activate's return value is ignored, so messages can come before the store answered: each waits for it.
  const loaded = load().catch((err) => ctx.log.warn(`could not read the records: ${err && err.message}`))

  // A win counts in storage with `increment` (atomic across windows); its time replaces the stored best only when
  // lower, re-read first since another window may have stored a better one meanwhile. One save at a time, in order.
  let saving = Promise.resolve()
  function saveWin({ draw, seconds }) {
    saving = saving.then(async () => {
      try {
        const total = typeof store.increment === 'function' ? await store.increment(WON_KEY(draw)) : await bump(WON_KEY(draw))
        const stored = await store.get(BEST_KEY(draw))
        if (typeof stored === 'number' && stored <= seconds) {
          if (controller.setStats({ won: { [draw]: total }, best: { [draw]: stored } })) push()
          return
        }
        await store.set(BEST_KEY(draw), seconds)
        if (controller.setStats({ won: { [draw]: total } })) push()
      } catch (err) {
        ctx.log.warn(`could not save the records: ${err && err.message}`)
      }
    })
    return saving
  }
  /** `increment` for a store without it (ctx.storage has one writer, the project's host). */
  async function bump(key) {
    const v = await store.get(key)
    const next = (typeof v === 'number' && Number.isFinite(v) ? v : 0) + 1
    await store.set(key, next)
    return next
  }

  // Finish plays one card home per tick; New game stops it (the controller is no longer finishing).
  let finishTimer = null
  function runFinish() {
    if (finishTimer) return
    const tick = () => {
      finishTimer = null
      const result = controller.finishStep()
      if (result.changed) push()
      if (result.win) saveWin(result.win)
      if (controller.finishing()) finishTimer = setTimeout(tick, FINISH_MS)
    }
    finishTimer = setTimeout(tick, FINISH_MS)
  }
  disposers.push(() => {
    clearTimeout(finishTimer)
    finishTimer = null
  })

  /** One action from a page or the title bar; posts the new state to every view when it changed. */
  async function act(msg) {
    const result = controller.act(msg)
    if (result.changed) push()
    if (result.finish) runFinish()
    if (result.win) await saveWin(result.win)
  }

  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(
      ctx.panels.onAction(PANEL, async (id) => {
        await loaded
        if (id === 'new') await act({ act: 'new' })
        else if (id === 'undo') await act({ act: 'undo' })
        else if (id === 'draw') {
          const draw = controller.draw() === 1 ? 3 : 1
          picked = true
          store.set(DRAW_KEY, draw).catch((err) => ctx.log.warn(`could not save the draw mode: ${err && err.message}`))
          await act({ act: 'new', draw })
        }
      }),
    )
  }

  disposers.push(
    ctx.panels.onMessage(PANEL, async (msg, from) => {
      await loaded
      if (!msg || typeof msg !== 'object') return
      if (msg.hello) {
        controller.setShown(viewOf(from), msg.visible !== false)
        // Every view hears it: the clock may have started for all of them.
        push()
        return
      }
      if (msg.act === 'seen') {
        if (controller.setShown(viewOf(from), msg.visible === true)) push()
        return
      }
      if (msg.act === 'goto') {
        // Returned (awaited) from the listener, so the focus acts in the view the click came from.
        const tabId = controller.pausedTab()
        if (!tabId) return
        const ok = await ctx.sessions.focus(tabId).catch(() => false)
        if (!ok) answer({ notice: 'That Claude tab is closed.' }, from)
        return
      }
      if (msg.act === 'new' && msg.draw !== undefined) return // the draw mode is switched from the title bar only
      await act(msg)
    }),
  )

  // A page gone (the panel hidden or closed in that view) stops the clock unless another view still shows it. The
  // page cannot say so itself: it is unmounted. An app without ctx.views only has the page's visibility to go by.
  if (typeof ctx.views === 'object' && ctx.views !== null && typeof ctx.views.onChange === 'function') {
    disposers.push(
      ctx.views.onChange(({ view, access }) => {
        if (access === undefined && controller.setShown(view, undefined)) push()
      }),
    )
  }

  if (typeof ctx.onSettingsChange === 'function') {
    disposers.push(
      ctx.onSettingsChange((settings) => {
        if (controller.setFour(fourOf(settings))) push()
      }),
    )
  }

  // The pause: every change of this window's Claude tabs (statuses included) comes as the whole list. The first list
  // is read once at start so a tab already working then is known when it turns to waiting; an onChange that came
  // first is newer, so the start list is dropped then.
  let changeSeen = false
  disposers.push(
    ctx.sessions.onChange((list) => {
      changeSeen = true
      if (controller.sessions(list)) push()
    }),
  )
  ctx.sessions
    .list()
    .then((list) => {
      if (!changeSeen) controller.sessions(list)
    })
    .catch((err) => ctx.log.warn(`could not list the Claude tabs: ${err && err.message}`))
}

exports.deactivate = () => {
  for (const dispose of disposers) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // the host is stopping anyway
    }
  }
  disposers = []
}
