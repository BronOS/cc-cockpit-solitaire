'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../panels/view.js')

test('a face-up card prints its rank and suit symbol; red, black and the suit class for the four-colour deck', () => {
  assert.deepEqual(V.face({ s: 'h', r: 1, up: true }), { rank: 'A', symbol: '♥', cls: 'card up red s-h', label: 'Ace of hearts' })
  assert.deepEqual(V.face({ s: 'c', r: 10, up: true }), { rank: '10', symbol: '♣', cls: 'card up black s-c', label: '10 of clubs' })
  assert.equal(V.face({ s: 'd', r: 12, up: true }).cls, 'card up red s-d')
  assert.equal(V.face({ s: 's', r: 13, up: true }).label, 'King of spades')
  for (const junk of [null, { up: false }, { s: 'h', r: 1, up: false }, { s: 'x', r: 1, up: true }, { s: 'h', r: 14, up: true }, { s: '__proto__', r: 1, up: true }]) {
    assert.equal(V.face(junk), null, JSON.stringify(junk))
  }
})

test('layout: seven columns fill the width; the cards keep their shape; a short zone caps the size', () => {
  const g = V.layout(330, 600)
  assert.ok(7 * g.cw + 8 * g.gap <= 330, 'fits the width')
  assert.ok(g.cw >= 36 && g.cw <= 42, `card width ${g.cw}`)
  assert.equal(g.ch, Math.round(g.cw * V.RATIO))
  assert.equal(g.x(0), g.left + g.gap)
  assert.equal(g.x(6) + g.cw + g.gap, g.left + g.width)
  assert.ok(g.tabY > g.topY + g.ch)
  // Wider panels, bigger cards.
  assert.ok(V.layout(600, 900).cw > g.cw)
  // A wide, short zone (the bottom one): the height caps the cards and the board is centred.
  const wide = V.layout(1400, 300)
  assert.ok(wide.cw <= 300 / 7.4 + 1)
  assert.ok(wide.left > 0)
  assert.equal(wide.left * 2 + wide.width <= 1400, true)
  // A tiny or junk size still gives usable numbers.
  for (const [w, h] of [[0, 0], [100, 50], [NaN, undefined]]) {
    const t = V.layout(w, h)
    assert.ok(t.cw >= 26 && Number.isFinite(t.x(3)), `${w}x${h}`)
  }
  assert.ok(V.layout(5000, 5000).cw <= 120)
})

test('columns: face-down cards close up, face-up ones show their corner; a long column closes up to fit', () => {
  const cw = 40
  const ch = 56
  const col = [{ up: false }, { up: false }, { up: true }, { up: true }, { up: true }]
  const roomy = V.columnOffsets(col, cw, 1000)
  assert.deepEqual(roomy.tops, [0, 6, 13, 30, 46])
  assert.equal(roomy.height, roomy.tops.at(-1) + ch)
  // A column of 6 face-down cards and a run of 13 in a felt only 300 px tall.
  const long = [...Array(6).fill({ up: false }), ...Array(13).fill({ up: true })]
  const tight = V.columnOffsets(long, cw, 300)
  assert.ok(tight.height <= 300, `height ${tight.height}`)
  const upStep = tight.tops[8] - tight.tops[7]
  assert.ok(upStep >= Math.floor(cw * 0.34), `a face-up step keeps the corner (${upStep})`)
  // Only a felt too small for that closes up further.
  const tiny = V.columnOffsets(long, cw, 200)
  assert.ok(tiny.height <= 201)
  assert.deepEqual(V.columnOffsets([], cw, 300), { tops: [], height: ch })
  assert.deepEqual(V.columnOffsets([{ up: true }], cw, 10), { tops: [0], height: ch })
})

test('the waste shows its top card, or in draw 3 up to three', () => {
  const w = (n, draw) => V.wasteShown({ draw, waste: Array(n).fill({}) })
  assert.equal(w(0, 1), 0)
  assert.equal(w(5, 1), 1)
  assert.equal(w(5, 3), 3)
  assert.equal(w(2, 3), 2)
})

test('the clock reads m:ss, h:mm:ss past an hour', () => {
  assert.equal(V.clock(0), '0:00')
  assert.equal(V.clock(65), '1:05')
  assert.equal(V.clock(3599), '59:59')
  assert.equal(V.clock(3661), '1:01:01')
  assert.equal(V.clock(-3), '0:00')
  assert.equal(V.clock('x'), '0:00')
})

test('covers: the Claude pause, then the win with moves, time and records; none in play', () => {
  assert.equal(V.coverFor(null), null)
  assert.equal(V.coverFor({ status: 'play', paused: null }), null)
  const p = V.coverFor({ status: 'play', paused: { name: 'Fix the scroll test' } })
  assert.equal(p.title, 'Claude is ready')
  assert.equal(p.dot, true)
  assert.equal(p.text, '“Fix the scroll test” is waiting for you.')
  assert.deepEqual(p.buttons.map((b) => [b.act, b.label, b.primary]), [
    ['resume', 'Resume game', true],
    ['goto', 'Go to the tab', false],
  ])
  const won = { status: 'won', paused: null, draw: 1, moves: 97, elapsedMs: 185400, record: true, stats: { won: 1, best: 185 } }
  const w = V.coverFor(won)
  assert.equal(w.title, 'You won!')
  assert.equal(w.text, '97 moves · 3:05')
  assert.equal(w.sub, 'New best time for Draw 1 · 1 game won')
  assert.deepEqual(w.buttons.map((b) => [b.act, b.primary]), [['new', true]])
  assert.equal(V.coverFor({ ...won, draw: 3, record: false, stats: { won: 12, best: 140 } }).sub, 'Best 2:20 in Draw 3 · 12 games won')
  assert.equal(V.coverFor({ ...won, moves: 1, record: false, stats: {} }).text, '1 move · 3:05')
})

test('keys: U undoes, N deals, Space draws; nothing else', () => {
  assert.equal(V.actOfKey('u'), 'undo')
  assert.equal(V.actOfKey('U'), 'undo')
  assert.equal(V.actOfKey('n'), 'new')
  assert.equal(V.actOfKey(' '), 'draw')
  for (const k of ['Enter', 'x', 'ArrowLeft', 'toString', '__proto__', undefined]) assert.equal(V.actOfKey(k), null, String(k))
})

test('a state is a new deal, a change or a resend', () => {
  assert.equal(V.changeOf(null, { game: 1, seq: 1 }), 'reset')
  assert.equal(V.changeOf({ game: 1, seq: 1 }, { game: 2, seq: 2 }), 'reset')
  assert.equal(V.changeOf({ game: 1, seq: 1 }, { game: 1, seq: 2 }), 'change')
  assert.equal(V.changeOf({ game: 1, seq: 2 }, { game: 1, seq: 2 }), 'same')
})

test('a drop lands on the target it overlaps most, among those it fits', () => {
  const a = { dest: { to: 'tab', col: 0 }, rect: { x: 0, y: 0, w: 40, h: 200 } }
  const b = { dest: { to: 'tab', col: 1 }, rect: { x: 45, y: 0, w: 40, h: 200 } }
  const f = { dest: { to: 'found' }, rect: { x: 45, y: -70, w: 40, h: 56 } }
  const card = { x: 30, y: 10, w: 40, h: 56 } // 10 px over a, 25 px over b
  assert.equal(V.dropOn(card, [a, b, f], () => true), b)
  assert.equal(V.dropOn(card, [a, b, f], (d) => d.col !== 1), a, 'b does not fit: the next best')
  assert.equal(V.dropOn(card, [a, b], () => false), null)
  assert.equal(V.dropOn({ x: 500, y: 500, w: 40, h: 56 }, [a, b], () => true), null, 'over nothing')
  assert.equal(V.overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), 0, 'touching is not over')
})
