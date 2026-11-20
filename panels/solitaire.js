'use strict'
// The Solitaire panel page. It draws the state the host sends and posts the person's moves; the game, its clock and
// the Claude pause live in the host (lib/controller.js), so this page can be closed or hidden at any time. The page
// works out a tap's target and a drop's fit itself, with the same rules (../lib/rules.js) on the view the host sent,
// so a card that fits nowhere shakes at once; the host checks every move again. Only the drawn card elements (kept by
// card, so a move slides them from where they were) and a drag in progress are the page's own.
//
// Everything sits in one IIFE: a top-level `const top` (or any name a window property already holds) in a classic
// script throws and kills the whole page, which the mock-up ran into.
;(function () {
  const R = globalThis.SolitaireRules
  const V = globalThis.SolitaireView
  const $ = (id) => document.getElementById(id)
  const felt = $('felt')
  const board = $('board')
  const cover = $('cover')

  /** A press that moves less than this is a tap; more is a drag. */
  const DRAG_PX = 6
  /** How long the slide of a moved card lasts (solitaire.css), while it is lifted over the others. */
  const SLIDE_MS = 160

  let state = null
  let shown = null // { game, seq } of the board drawn
  let notice = '' // a refusal for this page (Go to the tab on a closed tab), until the next state
  let shownAt = 0 // performance.now() when `state` came, for the running clock
  let tick = 0
  /** Card and slot elements by key: a face-up card by its suit and rank (so it slides when it moves), the rest by place. */
  const els = new Map()
  let targets = [] // where a drag can land: [{ dest, rect, el }] in board px
  let press = null // the press or drag in progress

  const post = (message) => ccPanel.post(message)
  const playing = () => !!state && !state.paused && state.status === 'play' && !state.finishing

  // ---- the clock ----

  function elapsedSeconds() {
    if (!state) return 0
    const ms = state.elapsedMs + (state.running ? performance.now() - shownAt : 0)
    return Math.floor(ms / 1000)
  }
  function drawClock() {
    $('time').textContent = V.clock(elapsedSeconds())
  }

  // ---- drawing ----

  /** Restarts a one-shot CSS animation class on an element that may carry it from before. */
  function replay(el, cls) {
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }

  /** A card's face: the rank and the suit symbol in the corner, the symbol large. Plain text only. */
  function paint(el, card, extra) {
    const f = V.face(card)
    const sig = f ? `${f.cls} ${extra}` : `card down ${extra}`
    if (el.dataset.sig === sig) return
    el.dataset.sig = sig
    el.className = sig
    el.textContent = ''
    if (!f) {
      el.removeAttribute('aria-label')
      return
    }
    const ix = document.createElement('span')
    ix.className = 'ix'
    const rank = document.createElement('b')
    rank.textContent = f.rank
    const sym = document.createElement('i')
    sym.textContent = f.symbol
    ix.append(rank, sym)
    const pip = document.createElement('span')
    pip.className = 'pip'
    pip.textContent = f.symbol
    el.append(ix, pip)
    el.setAttribute('aria-label', f.label)
  }

  let lifted = [] // cards raised over the others while they slide
  let lowerTimer = 0

  /**
   * Puts the element for `key` at (x, y). A new one is placed before it is in the page, so it starts where it
   * belongs (or at `from`, to slide in from the stock); one the state moved slides there, lifted over the others.
   */
  function place(keep, key, { kind = 'card', card, x, y, z, src = null, extra = '', text, from, slide }) {
    keep.add(key)
    let el = els.get(key)
    const created = !el
    if (created) {
      el = document.createElement('div')
      els.set(key, el)
    }
    if (kind === 'card') paint(el, card, extra)
    else {
      const cls = `slot ${extra}`
      if (el.className !== cls) el.className = cls
      if (el.textContent !== (text || '')) el.textContent = text || ''
    }
    el._src = src
    el.dataset.z = String(z)
    if (created) {
      el.style.left = `${from ? from.x : x}px`
      el.style.top = `${from ? from.y : y}px`
      el.style.zIndex = String(from ? 150 + z : z)
      board.append(el)
      if (from) {
        void el.offsetWidth
        el.style.left = `${x}px`
        el.style.top = `${y}px`
        lifted.push(el)
      }
      return el
    }
    // Dragged here (or dropped and the state came): the card is where the pointer left it, so it jumps, no slide.
    if (el.classList.contains('drag') || el.style.translate) {
      el.classList.remove('drag')
      el.classList.add('instant')
      el.style.translate = ''
      requestAnimationFrame(() => el.classList.remove('instant'))
    }
    const moved = el.style.left !== `${x}px` || el.style.top !== `${y}px`
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    if (moved && slide) {
      el.style.zIndex = String(150 + z)
      lifted.push(el)
    } else el.style.zIndex = String(z)
    return el
  }

  function drawBoard(instant = false) {
    if (!state) return
    const kind = V.changeOf(shown, state)
    const g = V.layout(felt.clientWidth, felt.clientHeight)
    const slide = kind === 'change' && !instant
    board.style.setProperty('--cw', `${g.cw}px`)
    board.style.setProperty('--ch', `${g.ch}px`)
    board.classList.toggle('four', !!state.four)
    if (kind === 'reset' || instant) {
      board.classList.add('instant')
      requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('instant')))
    }
    // A board changed under a press (another view moved, Undo from the title bar): the press is about cards that may
    // be elsewhere now, so it ends and they go to their places.
    if (kind !== 'same' && press) cancelPress()
    const keep = new Set()
    const next = []
    const stockAt = { x: g.x(0), y: g.topY }

    // The stock: one face-down card while it has cards (a tap draws), a slot with ↻ when the waste can go back.
    const stockEmpty = state.stock.length === 0
    place(keep, 'slot-stock', {
      kind: 'slot',
      x: stockAt.x,
      y: stockAt.y,
      z: 1,
      extra: `stock${stockEmpty ? (state.waste.length > 0 ? ' empty' : ' spent') : ''}`,
    }).dataset.stock = '1'
    if (!stockEmpty) {
      place(keep, 'stock', { card: { up: false }, x: stockAt.x, y: stockAt.y, z: 2, extra: 'stockcard' }).dataset.stock = '1'
    }

    // The waste: its top card, or in draw 3 up to three fanned toward the free third place; only the top one plays.
    // A card under another in the fan shows a strip of its left edge, so its corner stacks the suit under the rank.
    const n = V.wasteShown(state)
    const fan = Math.round(g.cw * 0.5)
    for (let k = 0; k < n; k++) {
      const card = state.waste[state.waste.length - n + k]
      const isTop = k === n - 1
      place(keep, `c-${card.s}${card.r}`, {
        card,
        x: g.x(1) + k * fan,
        y: g.topY,
        z: 3 + k,
        src: isTop ? { from: 'waste', s: card.s, r: card.r } : null,
        extra: isTop ? '' : 'fanned',
        from: kind === 'change' && !els.has(`c-${card.s}${card.r}`) && !instant ? stockAt : undefined,
        slide,
      })
    }

    // The foundations, one per suit in a fixed order: a slot with the suit's symbol, its top card on it.
    V.FOUND_ORDER.forEach((s, k) => {
      const x = g.x(3 + k)
      const slotEl = place(keep, `slot-f-${s}`, { kind: 'slot', x, y: g.topY, z: 1, extra: 'found', text: V.SYMBOLS[s] })
      next.push({ dest: { to: 'found' }, rect: { x, y: g.topY, w: g.cw, h: g.ch }, el: slotEl })
      const pile = state.found[s]
      const card = pile[pile.length - 1]
      if (card) place(keep, `c-${card.s}${card.r}`, { card, x, y: g.topY, z: 2, src: { from: 'found', s: card.s, r: card.r }, slide })
    })

    // The columns: face-down cards close up, face-up ones show their corner; a long column closes up to fit the felt.
    const avail = Math.max(g.ch, felt.clientHeight - g.tabY - g.gap)
    let bottom = g.tabY + g.ch
    state.tab.forEach((col, c) => {
      const x = g.x(c)
      const { tops, height } = V.columnOffsets(col, g.cw, avail)
      const slotEl = col.length === 0 ? place(keep, `slot-col-${c}`, { kind: 'slot', x, y: g.tabY, z: 1, extra: 'col', text: 'K' }) : null
      col.forEach((card, i) => {
        const y = g.tabY + tops[i]
        if (card.up) {
          place(keep, `c-${card.s}${card.r}`, { card, x, y, z: 10 + i, src: { from: 'tab', col: c, i, s: card.s, r: card.r }, slide })
        } else {
          place(keep, `d-${c}-${i}`, { card, x, y, z: 10 + i })
        }
      })
      bottom = Math.max(bottom, g.tabY + height)
      const end = col[col.length - 1]
      const endEl = end ? els.get(end.up ? `c-${end.s}${end.r}` : `d-${c}-${col.length - 1}`) : slotEl
      // The whole strip under a column takes a drop, so a short column is as easy a target as a long one.
      next.push({ dest: { to: 'tab', col: c }, rect: { x, y: g.tabY, w: g.cw, h: Math.max(height, felt.clientHeight - g.tabY) }, el: endEl })
    })

    for (const [key, el] of els) {
      if (keep.has(key)) continue
      el.remove()
      els.delete(key)
    }
    targets = next
    board.style.height = `${bottom + g.gap}px`

    // Lifted cards go back to their own layer once they have slid there.
    if (lifted.length > 0) {
      clearTimeout(lowerTimer)
      const now = lifted
      lifted = []
      lowerTimer = setTimeout(() => {
        for (const el of now) if (el.isConnected && !el.classList.contains('drag')) el.style.zIndex = el.dataset.z
      }, SLIDE_MS)
    }
    shown = { game: state.game, seq: state.seq }
  }

  function drawCover() {
    const spec = V.coverFor(state)
    if (!spec) {
      if (!cover.hidden && cover.contains(document.activeElement)) felt.focus({ preventScroll: true })
      cover.hidden = true
      cover.textContent = ''
      return
    }
    cover.className = `cover ${spec.kind}`
    cover.textContent = ''
    const big = document.createElement('div')
    big.className = 'big'
    if (spec.dot) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      big.append(dot)
    }
    // Plain text only: a tab's name is never put into HTML.
    big.append(spec.title)
    cover.append(big)
    for (const line of [spec.text, spec.sub]) {
      if (!line) continue
      const what = document.createElement('div')
      what.className = 'what'
      what.textContent = line
      cover.append(what)
    }
    if (notice) {
      const line = document.createElement('div')
      line.className = 'cc-error-line'
      line.textContent = notice
      cover.append(line)
    }
    const row = document.createElement('div')
    row.className = 'buttons'
    for (const b of spec.buttons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.dataset.act = b.act
      if (b.primary) btn.className = 'cc-primary'
      row.append(btn)
    }
    cover.append(row)
    cover.hidden = false
    // The board keeps the keyboard: Space is the draw key, and a press meant for the stock must not resume a pause
    // or deal again over a win the moment the cover comes up. Enter on the board presses the cover's main button.
  }

  function draw() {
    if (!state) return
    $('loading').hidden = true
    $('moves').textContent = String(state.moves)
    $('finish').hidden = !(state.canFinish && !state.paused)
    drawClock()
    clearInterval(tick)
    tick = state.running ? setInterval(drawClock, 250) : 0
    drawBoard()
    drawCover()
  }

  // ---- the host ----

  ccPanel.onMessage((message) => {
    if (!message || typeof message !== 'object') return
    if (message.state) {
      state = message.state
      shownAt = performance.now()
      notice = ''
      draw()
    } else if (typeof message.notice === 'string') {
      notice = message.notice
      drawCover()
    }
  })
  // Each new connection (the first one, a host restart) asks for the whole state and says whether the page is on
  // screen (the clock runs only while some view shows the board); an app without onConnect gets one ask.
  const hello = () => post({ hello: 1, visible: !document.hidden })
  if (typeof ccPanel.onConnect === 'function') ccPanel.onConnect(hello)
  else hello()
  document.addEventListener('visibilitychange', () => post({ act: 'seen', visible: !document.hidden }))
  // The panel being hidden or closed unmounts the page; the host also learns it from ctx.views. Best effort.
  window.addEventListener('pagehide', () => post({ act: 'seen', visible: false }))

  new ResizeObserver(() => drawBoard(true)).observe(felt)

  // ---- input: tap = smart move, drag = you choose ----

  /** The elements of a source's cards: the card and, in a column, every card on it. */
  function groupOf(src) {
    const cards = R.cardsAt(state, src) || []
    return cards.map((card) => els.get(`c-${card.s}${card.r}`)).filter(Boolean)
  }

  function shake(group) {
    for (const el of group) replay(el, 'shake')
  }

  let marked = null
  function mark(el) {
    if (marked === el) return
    if (marked) marked.classList.remove('drop')
    marked = el || null
    if (marked) marked.classList.add('drop')
  }

  /**
   * Whether a drag is about to leave the frame: within 8 px of its edge, or one more step like the last one would
   * take it out (a fast drag crosses the edge between two moves).
   */
  function nearEdge(p, e) {
    const nx = e.clientX + (e.clientX - p.lastX)
    const ny = e.clientY + (e.clientY - p.lastY)
    p.lastX = e.clientX
    p.lastY = e.clientY
    const out = (x, y, m) => x < m || y < m || x > window.innerWidth - m || y > window.innerHeight - m
    return out(e.clientX, e.clientY, 8) || out(nx, ny, 0)
  }

  /** The dragged lead card's rectangle in board px. */
  function dragRect(p, e) {
    const x = parseFloat(p.el.style.left) + (e.clientX - p.x)
    const y = parseFloat(p.el.style.top) + (e.clientY - p.y)
    return { x, y, w: p.el.offsetWidth, h: p.el.offsetHeight }
  }

  /** The target a drag would land on now, or null. */
  const targetOf = (p, e) => V.dropOn(dragRect(p, e), targets, (d) => R.canMove(state, p.src, d))

  /** Lets go of a drag that goes nowhere: the cards slide back. */
  function snapBack(group) {
    for (const el of group) {
      el.classList.remove('drag')
      el.style.translate = ''
      el.style.zIndex = el.dataset.z
    }
  }

  function cancelPress() {
    if (press && press.group) snapBack(press.group)
    press = null
    mark(null)
  }

  felt.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state) return
    // A press whose release never came (let go outside the panel's frame, which then hears nothing) ends here.
    if (press) cancelPress()
    if (!playing()) return
    const el = e.target.closest('.card, .slot')
    if (!el || !board.contains(el)) return
    if (el.dataset.stock) {
      press = { stock: true, id: e.pointerId }
    } else {
      const src = el._src
      if (!src || !R.cardsAt(state, src)) return
      press = { src, el, group: groupOf(src), x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId, moved: false }
    }
    try {
      felt.setPointerCapture(e.pointerId)
    } catch {
      // a pointer that is already gone: nothing to press
    }
  })

  felt.addEventListener('pointermove', (e) => {
    const p = press
    if (!p || p.stock || e.pointerId !== p.id) return
    // The button came up outside the frame (no pointerup reached it): the drag goes back.
    if ((e.buttons & 1) === 0) return cancelPress()
    // Nor does the frame hear anything once the pointer is out of it (Chromium routes a drag that leaves a panel's
    // frame elsewhere), so a drag that reaches the frame's edge goes back rather than hang there.
    if (nearEdge(p, e) && (p.moved || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= DRAG_PX)) return cancelPress()
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (!p.moved && Math.hypot(dx, dy) < DRAG_PX) return
    if (!playing()) return cancelPress()
    p.moved = true
    p.group.forEach((el, k) => {
      // A shake still running would hold its own translate over the drag's.
      el.classList.remove('shake')
      el.classList.add('drag')
      el.style.zIndex = String(200 + k)
      el.style.translate = `${dx}px ${dy}px`
    })
    const t = targetOf(p, e)
    mark(t ? t.el : null)
  })

  felt.addEventListener('pointerup', (e) => {
    const p = press
    if (!p || e.pointerId !== p.id) return
    press = null
    mark(null)
    if (!playing()) {
      if (p.group) snapBack(p.group)
      return
    }
    if (p.stock) {
      post({ act: 'draw' })
      return
    }
    if (!p.moved) {
      const dest = R.smartTarget(state, p.src)
      if (dest) post({ act: 'move', src: p.src, dest })
      else shake(p.group)
      return
    }
    const t = targetOf(p, e)
    if (!t) {
      snapBack(p.group)
      return
    }
    post({ act: 'move', src: p.src, dest: t.dest })
    // The host answers with the new board, which puts the cards there. Should it refuse (another view moved first),
    // nothing comes: the cards go back.
    const seq = state.seq
    setTimeout(() => {
      if (state && state.seq === seq) snapBack(p.group)
    }, 500)
  })

  felt.addEventListener('pointercancel', cancelPress)
  // Capture lost without a pointerup (pointerup clears `press` first), or the frame losing focus mid-drag.
  felt.addEventListener('lostpointercapture', () => {
    if (press) cancelPress()
  })
  window.addEventListener('blur', () => {
    if (press) cancelPress()
  })

  // Keys only while the board has focus, and only these; everything else goes on to the app.
  felt.addEventListener('keydown', (e) => {
    if (!state || e.target !== felt || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Enter' && !cover.hidden) {
      const primary = cover.querySelector('button.cc-primary')
      if (primary) {
        e.preventDefault()
        primary.click()
      }
      return
    }
    const act = V.actOfKey(e.key)
    if (!act) return
    e.preventDefault()
    if (act === 'undo') {
      if (playing() && state.canUndo) post({ act: 'undo' })
    } else if (act === 'draw') {
      if (playing()) post({ act: 'draw' })
    } else post({ act: 'new' })
  })

  $('finish').addEventListener('click', () => {
    if (playing() && state.canFinish) post({ act: 'finish' })
    // The button hides while Finish plays: the board takes the keyboard back (a mouse click shows no focus ring).
    felt.focus({ preventScroll: true })
  })

  cover.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]')
    if (btn) post({ act: btn.dataset.act })
  })
})()
