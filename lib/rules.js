'use strict'
// The Solitaire game itself: classic seven-column patience (Klondike). The deal, the stock and the waste (draw 1 or
// draw 3, unlimited passes), the four foundations, the seven columns, what fits where, moves of runs, the face-down
// card turned up under a move, smart moves for a tap, Finish and unlimited undo. Pure (no ctx, no clock, no DOM;
// `rng` injected), so `test/rules.test.js` runs every rule under node.
//
// The game lives in the host (lib/controller.js), one per project window: the page can be hidden (which unmounts it),
// closed or open in two views at once, and the game must outlive all of that. The page loads this same file as a
// classic script (the panel CSP allows the plugin's own files only, so the file serves both: UMD-style,
// `module.exports` under node, `SolitaireRules` in the page) to find a tap's target and a drop's fit at once, on the
// view the host sent it (`view`): the host's game with every face-down card blanked to `{ up: false }`. The host
// checks every move again on its own game: what the page posts is untrusted input.
//
// A game is a plain object mutated in place by `move`, `draw`, `undo` and `finishStep`, each of which checks what it
// gets, is a no-op when it does not apply and says whether anything changed. A card is `{ s, r, up }`: suit `s` one
// of `s h d c`, rank `r` 1 (ace) to 13 (king). A source names where a move starts and which card is there, so a
// click on a board another view has changed meanwhile moves nothing rather than some other card:
//   { from: 'waste', s, r }           the waste's top card
//   { from: 'found', s, r }           the top card of suit s's foundation
//   { from: 'tab', col, i, s, r }     card i of column col and the cards on it
// A destination is `{ to: 'found' }` (the card's own suit pile) or `{ to: 'tab', col }`.
;(function (root) {
  const SUITS = Object.freeze(['s', 'h', 'd', 'c'])
  const RED = Object.freeze({ s: false, h: true, d: true, c: false })
  const COLS = 7
  const DRAWS = Object.freeze([1, 3])
  const DEFAULT_DRAW = 1
  /**
   * Undo keeps this many steps, the oldest dropped first. Far more than any game takes (a game is a few hundred
   * moves), it only bounds the host's memory against a page that posts draws forever.
   */
  const HISTORY_CAP = 20000

  const isDraw = (draw) => draw === 1 || draw === 3
  const isSuit = (s) => typeof s === 'string' && SUITS.includes(s)
  const isRank = (r) => Number.isInteger(r) && r >= 1 && r <= 13
  const isCol = (col) => Number.isInteger(col) && col >= 0 && col < COLS
  const last = (pile) => (pile.length > 0 ? pile[pile.length - 1] : undefined)
  const isRed = (s) => RED[s] === true

  /**
   * A fresh deal: the 52 cards shuffled by `rng` ([0, 1) like Math.random), column c gets c + 1 cards with only its
   * last one face up (28 in all), the other 24 are the stock, face down. `status` is `play` or `won`.
   */
  function newGame(draw, rng = Math.random) {
    const deck = []
    for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push({ s, r, up: false })
    for (let i = deck.length - 1; i > 0; i--) {
      // Clamped, so an rng that answers 0.9999999 still picks a card in range.
      const j = Math.min(i, Math.floor(rng() * (i + 1)))
      const t = deck[i]
      deck[i] = deck[j]
      deck[j] = t
    }
    const tab = []
    for (let c = 0; c < COLS; c++) {
      const col = deck.splice(0, c + 1)
      col[c].up = true
      tab.push(col)
    }
    return {
      draw: isDraw(draw) ? draw : DEFAULT_DRAW,
      stock: deck,
      waste: [],
      found: { s: [], h: [], d: [], c: [] },
      tab,
      moves: 0,
      status: 'play',
      history: [],
    }
  }

  /** Whether `card` goes on its foundation now: the next rank of its suit (an ace on an empty one). */
  function fitsFound(game, card) {
    return !!card && card.up !== false && isSuit(card.s) && isRank(card.r) && game.found[card.s].length === card.r - 1
  }

  /** Whether `card` (and any run on it) goes on column `col`: a king on an empty one, else one rank lower and the other colour. */
  function fitsTab(game, card, col) {
    if (!card || card.up === false || !isSuit(card.s) || !isRank(card.r) || !isCol(col)) return false
    const top = last(game.tab[col])
    if (!top) return card.r === 13
    return top.up === true && top.r === card.r + 1 && isRed(top.s) !== isRed(card.s)
  }

  /**
   * The cards a source names, bottom first, or null when it names nothing that can move: junk, an empty pile, a
   * face-down card, or a card that is not the one the source says (the board changed under the click).
   */
  function cardsAt(game, src) {
    if (!src || typeof src !== 'object' || !isSuit(src.s) || !isRank(src.r)) return null
    const same = (card) => !!card && card.up === true && card.s === src.s && card.r === src.r
    if (src.from === 'waste') {
      const top = last(game.waste)
      return same(top) ? [top] : null
    }
    if (src.from === 'found') {
      const top = last(game.found[src.s])
      return same(top) ? [top] : null
    }
    if (src.from === 'tab') {
      if (!isCol(src.col)) return null
      const col = game.tab[src.col]
      if (!Number.isInteger(src.i) || src.i < 0 || src.i >= col.length || !same(col[src.i])) return null
      return col.slice(src.i)
    }
    return null
  }

  /** Whether moving `src` to `dest` is a legal move now (nothing changes). */
  function canMove(game, src, dest) {
    if (game.status !== 'play' || !dest || typeof dest !== 'object') return false
    const cards = cardsAt(game, src)
    if (!cards) return false
    if (dest.to === 'found') return cards.length === 1 && src.from !== 'found' && fitsFound(game, cards[0])
    if (dest.to === 'tab') {
      if (!isCol(dest.col) || (src.from === 'tab' && src.col === dest.col)) return false
      return fitsTab(game, cards[0], dest.col)
    }
    return false
  }

  // ---- undo: every change first saves the board it changes, packed small ----

  /** A card as one number: 0-51 for suit and rank, plus 52 when face up. */
  const pack = (card) => SUITS.indexOf(card.s) * 13 + (card.r - 1) + (card.up ? 52 : 0)
  const unpack = (n) => ({ s: SUITS[Math.floor((n % 52) / 13)], r: (n % 13) + 1, up: n >= 52 })

  function save(game) {
    game.history.push({
      stock: game.stock.map(pack),
      waste: game.waste.map(pack),
      found: SUITS.map((s) => game.found[s].length),
      tab: game.tab.map((col) => col.map(pack)),
      moves: game.moves,
    })
    if (game.history.length > HISTORY_CAP) game.history.splice(0, game.history.length - HISTORY_CAP)
  }

  /** Takes back the last change (a move, a draw, a recycle), as often as there are changes. Not after a win. */
  function undo(game) {
    if (game.status !== 'play' || game.history.length === 0) return false
    const h = game.history.pop()
    game.stock = h.stock.map(unpack)
    game.waste = h.waste.map(unpack)
    // A foundation is always ace up to its top, so its length is all it takes.
    SUITS.forEach((s, k) => {
      game.found[s] = Array.from({ length: h.found[k] }, (_, i) => ({ s, r: i + 1, up: true }))
    })
    game.tab = h.tab.map((col) => col.map(unpack))
    game.moves = h.moves
    return true
  }

  const won = (game) => SUITS.every((s) => game.found[s].length === 13)

  /**
   * Moves `src` to `dest` when it is legal: the cards leave their pile, a face-down card left on top of a column is
   * turned up (part of the same move, so one undo takes both back), the move is counted, and the last card home wins.
   * Returns whether anything changed.
   */
  function move(game, src, dest) {
    if (!canMove(game, src, dest)) return false
    save(game)
    let cards
    if (src.from === 'waste') cards = [game.waste.pop()]
    else if (src.from === 'found') cards = [game.found[src.s].pop()]
    else {
      cards = game.tab[src.col].splice(src.i)
      const top = last(game.tab[src.col])
      if (top && !top.up) top.up = true
    }
    if (dest.to === 'found') game.found[cards[0].s].push(cards[0])
    else game.tab[dest.col].push(...cards)
    game.moves++
    if (won(game)) game.status = 'won'
    return true
  }

  /**
   * A tap's move, or null when the card fits nowhere. A single card goes home to its foundation first; else the
   * first column it fits, looking rightward from its own and wrapping, a column with cards before an empty one. A
   * card that already heads its column (index 0) never hops to another empty column: that would change nothing.
   */
  function smartTarget(game, src) {
    if (game.status !== 'play') return null
    const cards = cardsAt(game, src)
    if (!cards) return null
    if (cards.length === 1 && src.from !== 'found' && canMove(game, src, { to: 'found' })) return { to: 'found' }
    const own = src.from === 'tab' ? src.col : -1
    const order = []
    for (let k = 0; k < COLS; k++) {
      const c = (own + 1 + k) % COLS
      if (c !== own) order.push(c)
    }
    for (const col of order) {
      if (game.tab[col].length > 0 && canMove(game, src, { to: 'tab', col })) return { to: 'tab', col }
    }
    if (src.from === 'tab' && src.i === 0) return null
    for (const col of order) {
      if (game.tab[col].length === 0 && canMove(game, src, { to: 'tab', col })) return { to: 'tab', col }
    }
    return null
  }

  /**
   * A tap on the stock: turns its next one or three cards (fewer when fewer are left) onto the waste, the last one
   * turned on top; an empty stock takes the waste back face down, in the order it was dealt (passes are unlimited).
   * Returns `draw`, `recycle`, or null when both are empty (nothing changes).
   */
  function draw(game) {
    if (game.status !== 'play') return null
    if (game.stock.length > 0) {
      save(game)
      for (let k = 0; k < game.draw && game.stock.length > 0; k++) {
        const card = game.stock.pop()
        card.up = true
        game.waste.push(card)
      }
      game.moves++
      return 'draw'
    }
    if (game.waste.length === 0) return null
    save(game)
    game.stock = game.waste.reverse().map((card) => ({ ...card, up: false }))
    game.waste = []
    game.moves++
    return 'recycle'
  }

  /**
   * Whether Finish can play the game out: the stock and the waste are empty and every card in the columns is face
   * up. Then it always can: the face-up cards of a column only ever came there as runs going down by one, so the
   * lowest card left is on top of its column, and it is the next one its foundation takes.
   */
  function canFinish(game) {
    return (
      game.status === 'play' &&
      game.stock.length === 0 &&
      game.waste.length === 0 &&
      game.tab.some((col) => col.length > 0) &&
      game.tab.every((col) => col.every((card) => card.up === true))
    )
  }

  /** One card of Finish: the lowest column top that fits goes home. Returns whether one moved. */
  function finishStep(game) {
    if (!canFinish(game)) return false
    let best = null
    for (let col = 0; col < COLS; col++) {
      const top = last(game.tab[col])
      if (top && fitsFound(game, top) && (!best || top.r < best.r)) best = { col, r: top.r, s: top.s }
    }
    if (!best) return false
    return move(game, { from: 'tab', col: best.col, i: game.tab[best.col].length - 1, s: best.s, r: best.r }, { to: 'found' })
  }

  /**
   * What a page may see: the game with every face-down card blanked to `{ up: false }` (the stock is all face down),
   * without the undo history. The rules above work on it as on the game, for the page's own taps and drops.
   */
  function view(game) {
    const face = (card) => (card.up ? { s: card.s, r: card.r, up: true } : { up: false })
    return {
      draw: game.draw,
      stock: game.stock.map(() => ({ up: false })),
      waste: game.waste.map(face),
      found: Object.fromEntries(SUITS.map((s) => [s, game.found[s].map(face)])),
      tab: game.tab.map((col) => col.map(face)),
      moves: game.moves,
      status: game.status,
    }
  }

  const api = {
    SUITS,
    COLS,
    DRAWS,
    DEFAULT_DRAW,
    HISTORY_CAP,
    isDraw,
    isSuit,
    isRank,
    isRed,
    newGame,
    fitsFound,
    fitsTab,
    cardsAt,
    canMove,
    move,
    smartTarget,
    draw,
    undo,
    won,
    canFinish,
    finishStep,
    view,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SolitaireRules = api
})(globalThis)
