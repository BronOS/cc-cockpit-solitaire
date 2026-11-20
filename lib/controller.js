'use strict'
// One project window's game: the deal (lib/rules.js), its clock, Finish, the Claude pause and the records, with no
// ctx in it (`now` and `rng` injected), so `test/controller.test.js` drives it with a fake clock. dist/host.js wires
// it to ctx: page messages in, `snapshot()` out to every view, session lists and shown views in, records out to
// storage.
//
// The clock is the host's, not the page's: hiding the panel unmounts the page, and a paused game must stay paused
// whatever the panel does. It runs from the first move until the win, and stands while the game is paused and while
// no view shows the panel (every page gone, or each one in a hidden browser tab or a minimized window): time spent
// away from the board is not play.

const rules = require('./rules.js')
const { createReadyWatch } = require('./pause.js')

/** `deal(draw, rng)` makes each new game (rules.newGame; tests give it a board of their own). */
function createController({ now = Date.now, rng = Math.random, draw, deal = rules.newGame } = {}) {
  let g = deal(draw, rng)
  /** Counts deals, so the page knows a new deal from a move on the one it drew. */
  let gameNo = 1
  /** Counts board changes (moves, draws, undos), so the page shakes or animates a change once, not on a resend. */
  let seq = 1
  /** The Claude tab the pause is about, `{ tabId, name }`, or null when the game is not paused. */
  let paused = null
  /** Finish is playing the cards home (the host steps it on a timer). */
  let finishing = false
  let started = false // a move was made in this deal: the clock has started
  let elapsed = 0 // ms counted before `since`
  let since = null // when the clock last started; null while it stands
  /** view -> whether its page is on screen. A view is in it from its page's hello until the page is gone. */
  const shown = new Map()
  /** Per draw mode: games won (app-wide, from storage and this window) and the best time in whole seconds. */
  const stats = { won: { 1: 0, 3: 0 }, best: { 1: null, 3: null } }
  let record = false // the game just won set a new best time
  let winSeconds = null // the time of the game just won
  let four = false // the four-colour deck (an app setting)
  const watch = createReadyWatch()

  const elapsedMs = () => elapsed + (since === null ? 0 : now() - since)
  const anyShown = () => [...shown.values()].some(Boolean)
  const shouldRun = () => started && g.status === 'play' && !paused && anyShown()
  /** Starts or stops the clock to match the game; returns whether it changed (the page shows it running or not). */
  function syncClock() {
    const run = shouldRun()
    if (run && since === null) {
      since = now()
      return true
    }
    if (!run && since !== null) {
      elapsed += now() - since
      since = null
      return true
    }
    return false
  }

  function reset(nextDraw) {
    g = deal(nextDraw === undefined ? g.draw : nextDraw, rng)
    gameNo++
    seq++
    paused = null
    finishing = false
    started = false
    elapsed = 0
    since = null
    record = false
    winSeconds = null
  }

  /** After any change to the board: the first one starts the clock, a win stops it and may set a record. */
  function afterChange() {
    seq++
    started = true
    if (g.status !== 'won') {
      syncClock()
      return { changed: true }
    }
    finishing = false
    syncClock()
    const seconds = Math.floor(elapsed / 1000)
    winSeconds = seconds
    const prev = stats.best[g.draw]
    record = typeof prev !== 'number' || seconds < prev
    if (record) stats.best[g.draw] = seconds
    stats.won[g.draw]++
    return { changed: true, win: { draw: g.draw, seconds, moves: g.moves } }
  }

  /** In play for the pause: a move made, not won, not playing itself out under Finish. */
  const inPlay = () => started && g.status === 'play' && !finishing

  return {
    /** The whole state the page draws: the view of the deal (face-down cards blank), never a tab id. */
    snapshot() {
      return {
        game: gameNo,
        seq,
        ...rules.view(g),
        canUndo: g.history.length > 0 && g.status === 'play' && !finishing,
        canFinish: rules.canFinish(g) && !finishing,
        finishing,
        elapsedMs: elapsedMs(),
        running: since !== null,
        paused: paused ? { name: paused.name } : null,
        four,
        record,
        stats: { won: stats.won[g.draw], best: stats.best[g.draw] },
      }
    },

    /**
     * One page action, untrusted. Returns `{ changed, win?, finish? }`: `win` `{ draw, seconds, moves }` when the
     * game was just won (the host stores the records), `finish` when Finish should start stepping. Moves, draws,
     * Undo and Finish are refused while paused (only Resume or New game goes on) and while Finish plays.
     */
    act(msg) {
      if (!msg || typeof msg !== 'object') return { changed: false }
      switch (msg.act) {
        case 'move':
          if (paused || finishing || !rules.move(g, msg.src, msg.dest)) return { changed: false }
          return afterChange()
        case 'draw':
          if (paused || finishing || !rules.draw(g)) return { changed: false }
          return afterChange()
        case 'undo':
          if (paused || finishing || !rules.undo(g)) return { changed: false }
          seq++
          return { changed: true }
        case 'finish':
          if (paused || finishing || !rules.canFinish(g)) return { changed: false }
          finishing = true
          return { changed: true, finish: true }
        case 'new':
          if (msg.draw !== undefined && !rules.isDraw(msg.draw)) return { changed: false }
          reset(msg.draw)
          return { changed: true }
        case 'resume':
          if (!paused) return { changed: false }
          paused = null
          syncClock()
          return { changed: true }
        default:
          return { changed: false }
      }
    },

    /** One card of Finish (the host calls it on a timer while `finishing()`): `{ changed, win? }`. */
    finishStep() {
      if (!finishing) return { changed: false }
      if (!rules.finishStep(g)) {
        finishing = false // cannot happen (canFinish held), but never step forever
        return { changed: true }
      }
      return afterChange()
    },

    /**
     * The window's Claude tabs (every `ctx.sessions` list). A tab going from working to waiting pauses a game in
     * play and stops its clock; while paused, a later one only renames the cover to it (the latest wins). A deal
     * with no move yet, a won game or one under Finish is never paused. Returns whether the state changed.
     */
    sessions(list) {
      const ready = watch.observe(list)
      if (ready.length === 0) return false
      const latest = ready[ready.length - 1]
      if (paused) {
        if (paused.tabId === latest.tabId && paused.name === latest.name) return false
        paused = latest
        return true
      }
      if (!inPlay()) return false
      paused = latest
      syncClock()
      return true
    },

    /**
     * Whether `view`'s page is on screen: `true` / `false` from the page (its hello, its visibility), `undefined`
     * when the page is gone (the panel hidden or closed in that view). Returns whether the clock started or stopped.
     */
    setShown(view, visible) {
      if (typeof view !== 'string') return false
      if (visible === undefined) shown.delete(view)
      else shown.set(view, visible === true)
      return syncClock()
    },

    /** The tab the pause names, for Go to the tab; null when not paused. */
    pausedTab: () => (paused ? paused.tabId : null),

    /**
     * Records from storage: `{ won: { 1, 3 }, best: { 1, 3 } }`. A stored count only raises the one this window
     * knows (storage counts every window's wins); a stored time only lowers it. Returns whether anything changed.
     */
    setStats(stored) {
      let changed = false
      for (const d of rules.DRAWS) {
        const w = stored && stored.won && stored.won[d]
        if (typeof w === 'number' && Number.isFinite(w) && w > stats.won[d]) {
          stats.won[d] = Math.floor(w)
          changed = true
        }
        const b = stored && stored.best && stored.best[d]
        if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) continue
        if (stats.best[d] === null || b < stats.best[d]) {
          stats.best[d] = Math.floor(b)
          changed = true
        }
        // Another window stored as good a time or better meanwhile: the game just won is no record after all.
        if (record && g.status === 'won' && g.draw === d && b <= winSeconds) {
          record = false
          changed = true
        }
      }
      return changed
    },

    /** The four-colour deck on or off (the app setting); returns whether it changed. */
    setFour(on) {
      const next = on === true
      if (next === four) return false
      four = next
      return true
    },

    draw: () => g.draw,
    moves: () => g.moves,
    canUndo: () => g.history.length > 0 && g.status === 'play' && !finishing,
    isPaused: () => paused !== null,
    finishing: () => finishing,
    /** No move made in this deal yet. */
    untouched: () => !started,
  }
}

module.exports = { createController }
