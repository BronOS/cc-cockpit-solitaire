'use strict'
// Pure helpers of the Solitaire page: what a card says, how big the cards are and where they go on the felt, how a
// long column closes up to fit, what a cover says, which key is which action, the clock's text, and whether a state
// is a new deal, a change or a resend. No DOM and no ccPanel, so `test/view.test.js` runs them under node; the page
// loads this file as a classic script (the CSP allows only the plugin's own files) and reads `SolitaireView`.
;(function (root) {
  const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
  const RANK_NAMES = ['', 'Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King']
  const SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' }
  const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }
  /** The foundations' order in the top row. */
  const FOUND_ORDER = ['s', 'h', 'd', 'c']

  const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)

  /**
   * One face-up card as `{ rank, symbol, cls, label }`: the rank and the suit symbol are always both printed (in the
   * corner and the symbol large), so no suit rests on its colour. `cls` colours it: red or black, and `s-<suit>`,
   * which the four-colour deck (a class on the board) turns blue for diamonds and green for clubs. Null for a
   * face-down or junk card.
   */
  function face(card) {
    if (!card || card.up !== true || !has(SYMBOLS, card.s) || !Number.isInteger(card.r) || card.r < 1 || card.r > 13) return null
    const red = card.s === 'h' || card.s === 'd'
    return {
      rank: RANKS[card.r],
      symbol: SYMBOLS[card.s],
      cls: `card up ${red ? 'red' : 'black'} s-${card.s}`,
      label: `${RANK_NAMES[card.r]} of ${SUIT_NAMES[card.s]}`,
    }
  }

  /** Card height per unit of width. */
  const RATIO = 1.4
  /** Space between piles and around the board, per unit of card width, within [3, 10] px. */
  const GAP = 0.12
  /** Cards no narrower than this (a tiny panel scrolls instead) and no wider (a huge zone centres the board). */
  const MIN_W = 26
  const MAX_W = 120
  /**
   * The felt's height in card widths the board needs at most: the top row, a gap, and the longest column there can
   * be (6 face-down cards and a run of 13) closed up to its tightest. So a short wide zone (the bottom one) gets
   * smaller cards rather than columns running off the felt.
   */
  const TALL = 7.4

  /**
   * Card size and pile positions for a felt `width` by `height` px: `{ cw, ch, gap, x(col), topY, tabY, left }`.
   * The width sets the size (seven columns and their gaps fill it); the height caps it (see TALL).
   */
  function layout(width, height) {
    const w = Math.max(0, Number(width) || 0)
    const h = Math.max(0, Number(height) || 0)
    // Seven cards and eight gaps fill the width: 7 * cw + 8 * gap, with gap = GAP * cw (clamped).
    let cw = w / (7 + 8 * GAP)
    if (h > 0) cw = Math.min(cw, h / TALL)
    cw = Math.floor(Math.max(MIN_W, Math.min(MAX_W, cw)))
    const gap = Math.round(Math.max(3, Math.min(10, cw * GAP)))
    const boardW = 7 * cw + 8 * gap
    const left = Math.max(0, Math.floor((w - boardW) / 2))
    const ch = Math.round(cw * RATIO)
    return {
      cw,
      ch,
      gap,
      left,
      width: boardW,
      x: (col) => left + gap + col * (cw + gap),
      topY: gap,
      tabY: gap + ch + gap * 2,
    }
  }

  /**
   * The top offset of every card of a column, and its height: face-down cards close up tight, face-up ones leave
   * their corner (rank and suit) in view. When the column would run past `avail` px, the face-up step shrinks first
   * (never below the corner's height), then the face-down one; only a column that still does not fit (a tiny panel)
   * closes up further, evenly. `col` is the column's cards (`{ up }`).
   */
  function columnOffsets(col, cw, avail) {
    const cards = Array.isArray(col) ? col : []
    const ch = Math.round(cw * RATIO)
    const steps = { down: 0, up: 0 }
    // Steps are taken by the card a step is above: the last card takes none.
    for (let i = 0; i < cards.length - 1; i++) steps[cards[i] && cards[i].up === true ? 'up' : 'down']++
    let down = cw * 0.16
    let up = cw * 0.42
    const minDown = cw * 0.07
    const minUp = cw * 0.34
    const need = () => steps.down * down + steps.up * up + ch
    const room = Math.max(ch, Number(avail) || 0)
    if (need() > room && steps.up > 0) up = Math.max(minUp, (room - ch - steps.down * down) / steps.up)
    if (need() > room && steps.down > 0) down = Math.max(minDown, (room - ch - steps.up * up) / steps.down)
    if (need() > room) {
      const k = (room - ch) / (steps.down * down + steps.up * up)
      down *= k
      up *= k
    }
    const tops = []
    let y = 0
    for (let i = 0; i < cards.length; i++) {
      tops.push(Math.round(y))
      y += cards[i] && cards[i].up === true ? up : down
    }
    return { tops, height: cards.length > 0 ? tops[tops.length - 1] + ch : ch }
  }

  /** How many waste cards show: the top one, or in draw 3 up to three fanned (only the top one plays). */
  const wasteShown = (state) => Math.min(state.waste.length, state.draw === 3 ? 3 : 1)

  /** Seconds as `m:ss`, `h:mm:ss` from an hour. */
  function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  /**
   * The cover over the board, or null for none: `{ kind, dot?, title, text?, sub?, buttons: [{ act, label,
   * primary }] }`. A pause wins (it only happens in play), then the win with its moves, time and the records.
   */
  function coverFor(state) {
    if (!state) return null
    if (state.paused) {
      return {
        kind: 'paused',
        dot: true,
        title: 'Claude is ready',
        text: `“${state.paused.name}” is waiting for you.`,
        buttons: [
          { act: 'resume', label: 'Resume game', primary: true },
          { act: 'goto', label: 'Go to the tab', primary: false },
        ],
      }
    }
    if (state.status === 'won') {
      const seconds = Math.floor((state.elapsedMs || 0) / 1000)
      const stats = state.stats || {}
      const parts = []
      if (state.record) parts.push(`New best time for Draw ${state.draw}`)
      else if (typeof stats.best === 'number') parts.push(`Best ${clock(stats.best)} in Draw ${state.draw}`)
      if (typeof stats.won === 'number' && stats.won > 0) parts.push(`${plural(stats.won, 'game', 'games')} won`)
      return {
        kind: 'won',
        title: 'You won!',
        text: `${plural(state.moves, 'move', 'moves')} · ${clock(seconds)}`,
        sub: parts.join(' · '),
        buttons: [{ act: 'new', label: 'New game', primary: true }],
      }
    }
    return null
  }

  const KEYS = { u: 'undo', U: 'undo', n: 'new', N: 'new', ' ': 'draw' }
  /** The action a key asks for while the board has focus (U, N, Space), or null. */
  const actOfKey = (key) => (has(KEYS, key) ? KEYS[key] : null)

  /**
   * How a state relates to the one drawn (`shown`: `{ game, seq }` or null): `reset` for another deal (nothing
   * slides), `change` for a move, a draw or an undo, `same` for a resend (a hello's answer, a pause, the clock).
   */
  function changeOf(shown, state) {
    if (!shown || shown.game !== state.game) return 'reset'
    return shown.seq === state.seq ? 'same' : 'change'
  }

  /** Overlap area of two rectangles `{ x, y, w, h }`, 0 when apart. */
  function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }

  /**
   * Where a dragged card lands: of `targets` (`[{ dest, rect }]`), the one its rectangle overlaps most among those
   * whose `dest` `fits` allows, or null.
   */
  function dropOn(rect, targets, fits) {
    let best = null
    let most = 0
    for (const t of targets) {
      const area = overlap(rect, t.rect)
      if (area > most && fits(t.dest)) {
        most = area
        best = t
      }
    }
    return best
  }

  const api = {
    RANKS,
    SYMBOLS,
    FOUND_ORDER,
    RATIO,
    face,
    layout,
    columnOffsets,
    wasteShown,
    clock,
    coverFor,
    actOfKey,
    changeOf,
    overlap,
    dropOn,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SolitaireView = api
})(globalThis)
