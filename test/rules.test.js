'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../lib/rules.js')

const card = (s, r, up = true) => ({ s, r, up })
const down = (s, r) => card(s, r, false)
/** An empty board: no stock, no waste, empty foundations and columns. */
function blank(draw = 1) {
  return { draw, stock: [], waste: [], found: { s: [], h: [], d: [], c: [] }, tab: [[], [], [], [], [], [], []], moves: 0, status: 'play', history: [] }
}
/** Suit s's foundation filled from the ace up to rank r. */
const upTo = (s, r) => Array.from({ length: r }, (_, i) => card(s, i + 1))
const tabSrc = (game, col, i) => ({ from: 'tab', col, i, s: game.tab[col][i].s, r: game.tab[col][i].r })
const key = (c) => `${c.s}${c.r}`
/** A seeded rng (mulberry32), so a deal is the same on every run. */
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('the deal: 28 cards in seven columns with only the tops face up, 24 in the stock face down', () => {
  const g = R.newGame(1, seeded(1))
  assert.equal(g.tab.length, 7)
  g.tab.forEach((col, c) => {
    assert.equal(col.length, c + 1, `column ${c}`)
    col.forEach((x, i) => assert.equal(x.up, i === c, `column ${c} card ${i}`))
  })
  assert.equal(g.tab.flat().length, 28)
  assert.equal(g.stock.length, 24)
  assert.ok(g.stock.every((x) => x.up === false))
  assert.deepEqual(g.waste, [])
  assert.deepEqual(g.found, { s: [], h: [], d: [], c: [] })
  assert.equal(g.status, 'play')
  assert.equal(g.moves, 0)
  const all = [...g.tab.flat(), ...g.stock].map(key)
  assert.equal(new Set(all).size, 52, 'every card once')
})

test('the deal follows the rng, takes the draw mode, and an rng at the edge still deals', () => {
  assert.deepEqual(R.newGame(1, seeded(7)), R.newGame(1, seeded(7)))
  assert.notDeepEqual(R.newGame(1, seeded(7)).stock, R.newGame(1, seeded(8)).stock)
  assert.equal(R.newGame(3, seeded(1)).draw, 3)
  for (const junk of [2, '3', null, undefined, 0]) assert.equal(R.newGame(junk, seeded(1)).draw, 1)
  const edge = R.newGame(1, () => 0.9999999999)
  assert.equal(new Set([...edge.tab.flat(), ...edge.stock].map(key)).size, 52)
})

test('foundations take the ace, then the next rank of the same suit only', () => {
  const g = blank()
  assert.ok(R.fitsFound(g, card('h', 1)))
  assert.ok(!R.fitsFound(g, card('h', 2)))
  g.found.h = upTo('h', 4)
  assert.ok(R.fitsFound(g, card('h', 5)))
  assert.ok(!R.fitsFound(g, card('h', 6)))
  assert.ok(!R.fitsFound(g, card('d', 5)), 'another suit')
  assert.ok(!R.fitsFound(g, down('h', 5)), 'a face-down card')
  assert.ok(!R.fitsFound(g, { s: 'x', r: 1, up: true }))
  assert.ok(!R.fitsFound(g, null))
})

test('columns take a king when empty, else one rank lower in the other colour', () => {
  const g = blank()
  assert.ok(R.fitsTab(g, card('s', 13), 0))
  assert.ok(!R.fitsTab(g, card('s', 12), 0), 'only a king on an empty column')
  g.tab[1] = [card('s', 8)]
  assert.ok(R.fitsTab(g, card('h', 7), 1), 'red on black')
  assert.ok(R.fitsTab(g, card('d', 7), 1))
  assert.ok(!R.fitsTab(g, card('c', 7), 1), 'black on black')
  assert.ok(!R.fitsTab(g, card('s', 7), 1))
  assert.ok(!R.fitsTab(g, card('h', 6), 1), 'two lower')
  assert.ok(!R.fitsTab(g, card('h', 8), 1), 'same rank')
  assert.ok(!R.fitsTab(g, card('h', 9), 1), 'higher')
  g.tab[2] = [down('s', 8)]
  assert.ok(!R.fitsTab(g, card('h', 7), 2), 'never on a face-down card')
  g.tab[3] = [card('h', 10)]
  assert.ok(R.fitsTab(g, card('c', 9), 3), 'black on red')
  assert.ok(!R.fitsTab(g, card('h', 7), 7), 'no eighth column')
  assert.ok(!R.fitsTab(g, card('h', 7), -1))
})

test('a run moves whole, and the face-down card it leaves on top turns up, in one move', () => {
  const g = blank()
  g.tab[0] = [down('c', 2), card('s', 9), card('h', 8), card('c', 7)]
  g.tab[1] = [card('d', 10)]
  assert.ok(R.move(g, tabSrc(g, 0, 1), { to: 'tab', col: 1 }))
  assert.deepEqual(g.tab[1].map(key), ['d10', 's9', 'h8', 'c7'])
  assert.deepEqual(g.tab[0], [card('c', 2)], 'turned up')
  assert.equal(g.moves, 1)
  assert.equal(g.history.length, 1)
  // Part of a run moves too: the 8 and the 7 onto a black 9.
  g.tab[2] = [card('c', 9)]
  assert.ok(R.move(g, tabSrc(g, 1, 2), { to: 'tab', col: 2 }))
  assert.deepEqual(g.tab[2].map(key), ['c9', 'h8', 'c7'])
  assert.deepEqual(g.tab[1].map(key), ['d10', 's9'])
})

test('moves that do not fit change nothing', () => {
  const g = blank()
  g.tab[0] = [card('h', 5), card('s', 4)]
  g.tab[1] = [card('d', 6)]
  g.found.s = upTo('s', 2)
  g.waste = [card('c', 12)]
  const before = structuredClone(g)
  assert.ok(!R.move(g, tabSrc(g, 0, 0), { to: 'found' }), 'a run never goes to a foundation')
  assert.ok(!R.move(g, tabSrc(g, 0, 0), { to: 'tab', col: 0 }), 'onto its own column')
  assert.ok(!R.move(g, tabSrc(g, 0, 0), { to: 'tab', col: 1 }), 'red on red')
  assert.ok(!R.move(g, { from: 'waste', s: 'c', r: 12 }, { to: 'tab', col: 2 }), 'a queen on an empty column')
  assert.ok(!R.move(g, { from: 'found', s: 's', r: 2 }, { to: 'found' }), 'foundation to foundation')
  assert.deepEqual(g, before)
})

test('the waste top and a foundation top move; a foundation card can come back down', () => {
  const g = blank()
  g.waste = [card('h', 3), card('h', 1)]
  assert.ok(R.move(g, { from: 'waste', s: 'h', r: 1 }, { to: 'found' }))
  assert.deepEqual(g.found.h.map(key), ['h1'])
  assert.ok(!R.move(g, { from: 'waste', s: 'h', r: 1 }, { to: 'found' }), 'the card is gone from the waste')
  g.found.s = upTo('s', 5)
  g.tab[4] = [card('h', 6)]
  assert.ok(R.move(g, { from: 'found', s: 's', r: 5 }, { to: 'tab', col: 4 }))
  assert.deepEqual(g.found.s.length, 4)
  assert.deepEqual(g.tab[4].map(key), ['h6', 's5'])
})

test('junk sources and destinations are refused', () => {
  const g = blank()
  g.tab[0] = [down('c', 2), card('s', 9)]
  g.tab[1] = [card('d', 10)]
  g.waste = [card('h', 1)]
  const before = structuredClone(g)
  const dest = { to: 'tab', col: 1 }
  for (const src of [
    null,
    undefined,
    'tab',
    7,
    {},
    { from: 'tab', col: 0, i: 1 }, // no card named
    { from: 'tab', col: 0, i: 1, s: 'h', r: 9 }, // another card than the one there
    { from: 'tab', col: 0, i: 0, s: 'c', r: 2 }, // face down
    { from: 'tab', col: 0, i: 2, s: 's', r: 9 },
    { from: 'tab', col: 0, i: -1, s: 's', r: 9 },
    { from: 'tab', col: 0, i: 1.5, s: 's', r: 9 },
    { from: 'tab', col: '0', i: 1, s: 's', r: 9 },
    { from: 'tab', col: 9, i: 1, s: 's', r: 9 },
    { from: 'waste', s: 'h', r: 2 },
    { from: 'found', s: '__proto__', r: 1 },
    { from: 'found', s: 'toString', r: 1 },
    { from: 'stock', s: 's', r: 9 },
    { from: 'tab', col: 0, i: 1, s: 's', r: 14 },
  ]) {
    assert.ok(!R.move(g, src, dest), JSON.stringify(src))
    assert.equal(R.smartTarget(g, src), null, JSON.stringify(src))
  }
  const src = tabSrc(g, 0, 1)
  for (const d of [null, {}, 'found', { to: 'tab' }, { to: 'tab', col: 7 }, { to: 'tab', col: '1' }, { to: 'stock' }, { to: '__proto__' }]) {
    assert.ok(!R.move(g, src, d), JSON.stringify(d))
  }
  assert.deepEqual(g, before)
})

test('draw 1 turns one card, draw 3 three (the last one on top), fewer when fewer are left', () => {
  const g = blank(1)
  g.stock = [down('s', 1), down('s', 2), down('s', 3), down('s', 4)] // the stock's top is its last card
  assert.equal(R.draw(g), 'draw')
  assert.deepEqual(g.waste, [card('s', 4)])
  assert.equal(g.stock.length, 3)
  assert.equal(g.moves, 1)

  const h = blank(3)
  h.stock = [down('s', 1), down('s', 2), down('s', 3), down('s', 4)]
  assert.equal(R.draw(h), 'draw')
  assert.deepEqual(h.waste.map(key), ['s4', 's3', 's2'])
  assert.ok(h.waste.every((x) => x.up))
  assert.equal(R.draw(h), 'draw')
  assert.deepEqual(h.waste.map(key), ['s4', 's3', 's2', 's1'], 'only one was left')
  assert.equal(h.stock.length, 0)
})

test('an empty stock takes the waste back face down in the order it was dealt; passes are unlimited', () => {
  const g = blank(1)
  g.stock = [down('d', 1), down('d', 2), down('d', 3)]
  const order = []
  for (let k = 0; k < 3; k++) {
    R.draw(g)
    order.push(key(g.waste.at(-1)))
  }
  assert.deepEqual(order, ['d3', 'd2', 'd1'])
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(R.draw(g), 'recycle')
    assert.deepEqual(g.waste, [])
    assert.ok(g.stock.every((x) => x.up === false))
    const again = []
    for (let k = 0; k < 3; k++) {
      R.draw(g)
      again.push(key(g.waste.at(-1)))
    }
    assert.deepEqual(again, order, `pass ${pass + 2} deals the same order`)
  }
  const empty = blank()
  assert.equal(R.draw(empty), null, 'nothing to draw or turn over')
  assert.equal(empty.moves, 0)
  assert.equal(empty.history.length, 0)
})

test('smart move: a single card goes home first', () => {
  const g = blank()
  g.tab[0] = [card('h', 1)]
  g.tab[1] = [card('s', 2)]
  assert.deepEqual(R.smartTarget(g, tabSrc(g, 0, 0)), { to: 'found' })
  g.waste = [card('c', 1)]
  assert.deepEqual(R.smartTarget(g, { from: 'waste', s: 'c', r: 1 }), { to: 'found' })
})

test('smart move: then a column with cards, looking rightward from its own, before an empty one', () => {
  const g = blank()
  g.tab[0] = [card('c', 8)]
  g.tab[2] = [card('h', 9)]
  g.tab[3] = [card('s', 13), card('d', 12)] // no fit
  g.tab[5] = [card('d', 9)]
  // From column 4 the search goes 5, 6, 0, 1, 2, 3: the red 9 in column 5 comes before the one in column 2.
  g.tab[4] = [card('c', 8)]
  assert.deepEqual(R.smartTarget(g, tabSrc(g, 4, 0)), { to: 'tab', col: 5 })
  // From column 0 the search goes 1, 2, ...: column 2 first.
  assert.deepEqual(R.smartTarget(g, tabSrc(g, 0, 0)), { to: 'tab', col: 2 })
  // Empty columns (1, 6) come only after every column with cards: a king goes there.
  g.waste = [card('h', 13)]
  assert.deepEqual(R.smartTarget(g, { from: 'waste', s: 'h', r: 13 }), { to: 'tab', col: 1 })
})

test('smart move: a king heading its column never hops to another empty one; one under cards does', () => {
  const g = blank()
  g.tab[0] = [card('s', 13), card('h', 12)]
  g.tab[3] = [down('c', 5), card('d', 13)]
  assert.equal(R.smartTarget(g, tabSrc(g, 0, 0)), null)
  assert.deepEqual(R.smartTarget(g, tabSrc(g, 3, 1)), { to: 'tab', col: 4 }, 'a king off a face-down card frees it')
})

test('smart move: a foundation card comes back to a column; null when nothing fits', () => {
  const g = blank()
  g.found.h = upTo('h', 6)
  g.tab[2] = [card('c', 7)]
  assert.deepEqual(R.smartTarget(g, { from: 'found', s: 'h', r: 6 }), { to: 'tab', col: 2 })
  g.tab[2] = [card('d', 7)]
  assert.equal(R.smartTarget(g, { from: 'found', s: 'h', r: 6 }), null, 'never back to its own foundation')
  g.tab[0] = [card('h', 4)]
  assert.equal(R.smartTarget(g, tabSrc(g, 0, 0)), null)
})

test('Finish: only when the stock and the waste are empty and every column card is up; it always plays out', () => {
  const g = blank()
  for (const s of R.SUITS) g.found[s] = upTo(s, 9)
  g.tab[0] = [card('s', 13), card('h', 12), card('s', 11), card('h', 10)]
  g.tab[1] = [card('h', 13), card('s', 12), card('h', 11), card('s', 10)]
  g.tab[2] = [card('d', 13), card('c', 12), card('d', 11), card('c', 10)]
  g.tab[3] = [card('c', 13), card('d', 12), card('c', 11), card('d', 10)]
  assert.ok(R.canFinish(g))
  g.stock = [down('s', 1)]
  assert.ok(!R.canFinish(g), 'the stock has a card')
  g.stock = []
  g.waste = [card('s', 1)]
  assert.ok(!R.canFinish(g), 'the waste has a card')
  g.waste = []
  g.tab[3][0].up = false
  assert.ok(!R.canFinish(g), 'a face-down card')
  g.tab[3][0].up = true
  let steps = 0
  while (R.finishStep(g)) steps++
  assert.equal(steps, 16)
  assert.equal(g.status, 'won')
  assert.ok(R.won(g))
  assert.equal(g.moves, 16, 'each card home is a move')
  assert.ok(!R.canFinish(g))
  assert.ok(!R.finishStep(g))
})

test('the win: the last card home; then nothing moves, draws or undoes', () => {
  const g = blank()
  for (const s of ['s', 'h', 'd']) g.found[s] = upTo(s, 13)
  g.found.c = upTo('c', 12)
  g.waste = [card('c', 13)]
  assert.ok(!R.canFinish(g), 'the waste has a card: Finish is not offered, the person plays it')
  assert.ok(R.move(g, { from: 'waste', s: 'c', r: 13 }, { to: 'found' }))
  assert.equal(g.status, 'won')
  assert.ok(!R.move(g, { from: 'found', s: 'c', r: 13 }, { to: 'tab', col: 0 }))
  assert.equal(R.draw(g), null)
  assert.ok(!R.undo(g))
  assert.equal(R.smartTarget(g, { from: 'found', s: 'c', r: 13 }), null)
})

test('undo takes back moves, flips, draws and recycles, as often as there were changes', () => {
  const g = R.newGame(1, seeded(3))
  const start = structuredClone(g)
  const states = [structuredClone(g)]
  // Draw through the whole stock and turn it over, with the moves the smart rule finds on the way.
  for (let k = 0; k < 30; k++) {
    let moved = false
    for (let c = 0; c < 7 && !moved; c++) {
      const col = g.tab[c]
      const i = col.findIndex((x) => x.up)
      if (i >= 0) {
        const dest = R.smartTarget(g, tabSrc(g, c, i))
        if (dest && R.move(g, tabSrc(g, c, i), dest)) moved = true
      }
    }
    if (!moved) R.draw(g)
    states.push(structuredClone(g))
  }
  assert.ok(g.history.length > 0)
  const n = g.history.length
  for (let k = n; k > 0; k--) {
    assert.ok(R.undo(g))
    const want = states[k - 1]
    assert.deepEqual({ ...g, history: [] }, { ...want, history: [] }, `undo ${n - k + 1}`)
  }
  assert.deepEqual({ ...g, history: [] }, { ...start, history: [] })
  assert.ok(!R.undo(g), 'nothing left to undo')
})

test('undo keeps at most HISTORY_CAP steps, dropping the oldest', () => {
  const g = blank()
  g.stock = [down('s', 1)]
  for (let k = 0; k < R.HISTORY_CAP + 5; k++) R.draw(g) // draw and recycle, over and over
  assert.equal(g.history.length, R.HISTORY_CAP)
})

test('the view blanks face-down cards and leaves out the history; the rules read it as the game', () => {
  const g = R.newGame(3, seeded(5))
  R.draw(g)
  const v = R.view(g)
  assert.equal(v.stock.length, g.stock.length)
  assert.ok(v.stock.every((x) => x.up === false && x.s === undefined && x.r === undefined))
  v.tab.forEach((col, c) => col.forEach((x, i) => (g.tab[c][i].up ? assert.deepEqual(x, g.tab[c][i]) : assert.deepEqual(x, { up: false }))))
  assert.deepEqual(v.waste, g.waste)
  assert.equal(v.history, undefined)
  assert.equal(v.draw, 3)
  // Every tap the page works out on the view is the host's on the game.
  for (let c = 0; c < 7; c++) {
    const i = g.tab[c].length - 1
    assert.deepEqual(R.smartTarget(v, tabSrc(g, c, i)), R.smartTarget(g, tabSrc(g, c, i)))
  }
  const top = g.waste.at(-1)
  assert.deepEqual(R.smartTarget(v, { from: 'waste', s: top.s, r: top.r }), R.smartTarget(g, { from: 'waste', s: top.s, r: top.r }))
  assert.equal(JSON.stringify(v).includes('history'), false)
})

test('a whole game can be won by play, and every card stays one of a kind', () => {
  // Play seeded deals with the smart rule and draws until one is won or none moves any more: the rules hold
  // together over whole games (52 distinct cards at every step, foundations in order).
  let wins = 0
  for (let seed = 1; seed <= 40; seed++) {
    const g = R.newGame(1, seeded(seed))
    let idle = 0
    for (let step = 0; step < 2000 && g.status === 'play' && idle < 60; step++) {
      if (R.canFinish(g)) {
        R.finishStep(g)
        continue
      }
      let moved = false
      const srcs = []
      if (g.waste.length) srcs.push({ from: 'waste', s: g.waste.at(-1).s, r: g.waste.at(-1).r })
      for (let c = 0; c < 7; c++) {
        const col = g.tab[c]
        const i = col.findIndex((x) => x.up)
        if (i > 0 || (i === 0 && col[0].r !== 13)) srcs.push(tabSrc(g, c, i))
        if (col.length) srcs.push(tabSrc(g, c, col.length - 1))
      }
      for (const src of srcs) {
        const dest = R.smartTarget(g, src)
        if (dest && (dest.to === 'found' || src.from === 'waste' || src.i === g.tab[src.col].findIndex((x) => x.up)) && R.move(g, src, dest)) {
          moved = true
          break
        }
      }
      if (moved) idle = 0
      else {
        R.draw(g)
        idle++
      }
      const cards = [...g.stock, ...g.waste, ...g.tab.flat(), ...R.SUITS.flatMap((s) => g.found[s])]
      assert.equal(new Set(cards.map(key)).size, 52)
      for (const s of R.SUITS) g.found[s].forEach((x, i) => assert.deepEqual([x.s, x.r], [s, i + 1]))
    }
    if (g.status === 'won') wins++
  }
  assert.ok(wins > 0, 'some seeded deal was won')
})
