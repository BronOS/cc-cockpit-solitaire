'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController } = require('../lib/controller.js')
const { tabName } = require('../lib/pause.js')

const card = (s, r, up = true) => ({ s, r, up })
const upTo = (s, r) => Array.from({ length: r }, (_, i) => card(s, i + 1))
/**
 * A deal one draw from Finish: the stock holds the queen of clubs, every foundation is up to its jack, and the
 * columns hold the other queens and the kings, face up. Draw, send the queen home, then Finish plays the rest (7).
 */
const nearWin = (draw = 1) => ({
  draw: draw === 3 ? 3 : 1,
  stock: [card('c', 12, false)],
  waste: [],
  found: { s: upTo('s', 11), h: upTo('h', 11), d: upTo('d', 11), c: upTo('c', 11) },
  tab: [[card('s', 13), card('h', 12)], [card('h', 13), card('s', 12)], [card('d', 13)], [card('c', 13), card('d', 12)], [], [], []],
  moves: 0,
  status: 'play',
  history: [],
})
const QUEEN = { act: 'move', src: { from: 'waste', s: 'c', r: 12 }, dest: { to: 'found' } }
const tab = (tabId, status, extra = {}) => ({ tabId, status, ...extra })

function clock() {
  let t = 1000
  return { now: () => t, add: (ms) => (t += ms) }
}
/** A controller on the near-win deal, with a fake clock and the desktop page shown. */
function make(opts = {}) {
  const c = clock()
  const ctl = createController({ now: c.now, deal: nearWin, ...opts })
  ctl.setShown('desktop', true)
  return { ctl, c }
}
function playOut(ctl) {
  let r
  do r = ctl.finishStep()
  while (r.changed && !r.win && ctl.finishing())
  return r
}

test('the snapshot: the deal as the page may see it, never the history or a tab id', () => {
  const ctl = createController({ rng: () => 0.5 })
  const s = ctl.snapshot()
  assert.equal(s.tab.flat().length, 28)
  assert.ok(s.tab.flat().every((x) => x.up || (x.s === undefined && x.r === undefined)), 'face-down cards blank')
  assert.equal(s.stock.length, 24)
  assert.equal(s.history, undefined)
  assert.equal(s.canUndo, false)
  assert.equal(s.canFinish, false)
  assert.equal(s.paused, null)
  assert.equal(s.running, false)
  assert.equal(s.draw, 1)
  assert.deepEqual(s.stats, { won: 0, best: null })
  assert.equal(ctl.untouched(), true)
})

test('the clock starts at the first move, not before, and counts while a view shows the board', () => {
  const { ctl, c } = make()
  c.add(5000)
  assert.equal(ctl.snapshot().elapsedMs, 0, 'no time before the first move')
  assert.ok(ctl.act({ act: 'draw' }).changed)
  assert.equal(ctl.snapshot().running, true)
  c.add(3000)
  assert.equal(ctl.snapshot().elapsedMs, 3000)
  assert.equal(ctl.snapshot().moves, 1)
})

test('the clock stands while no view shows the board: hidden, closed, or a page out of sight', () => {
  const { ctl, c } = make()
  ctl.act({ act: 'draw' })
  c.add(1000)
  ctl.setShown('web:1', true)
  assert.equal(ctl.setShown('desktop', undefined), false, 'another view still shows it')
  c.add(1000)
  assert.equal(ctl.setShown('web:1', false), true, 'the last one hid: the clock stops')
  assert.equal(ctl.snapshot().running, false)
  c.add(60000)
  assert.equal(ctl.snapshot().elapsedMs, 2000)
  assert.equal(ctl.setShown('desktop', true), true, 'shown again: it goes on')
  c.add(500)
  assert.equal(ctl.snapshot().elapsedMs, 2500)
  ctl.setShown('desktop', undefined)
  ctl.setShown('web:1', undefined)
  c.add(9000)
  assert.equal(ctl.snapshot().elapsedMs, 2500)
  assert.equal(ctl.setShown(42, true), false, 'junk view')
})

test('a first move made with no view shown starts the clock only once one shows it', () => {
  const c = clock()
  const ctl = createController({ now: c.now, deal: nearWin })
  ctl.act({ act: 'draw' })
  assert.equal(ctl.snapshot().running, false)
  c.add(4000)
  ctl.setShown('desktop', true)
  c.add(1000)
  assert.equal(ctl.snapshot().elapsedMs, 1000)
})

test('pause: a working tab turning waiting while playing pauses, stops the clock and refuses moves; Resume goes on', () => {
  const { ctl, c } = make()
  ctl.sessions([tab('t1', 'working', { title: 'Fix the scroll test' })])
  ctl.act({ act: 'draw' })
  c.add(2000)
  assert.equal(ctl.sessions([tab('t1', 'waiting', { title: 'Fix the scroll test' })]), true)
  assert.deepEqual(ctl.snapshot().paused, { name: 'Fix the scroll test' })
  assert.equal(ctl.pausedTab(), 't1')
  assert.equal(ctl.snapshot().running, false)
  c.add(30000)
  for (const m of [QUEEN, { act: 'draw' }, { act: 'undo' }, { act: 'finish' }]) assert.equal(ctl.act(m).changed, false, m.act)
  assert.equal(ctl.snapshot().canUndo, true, 'there is a move to undo, refused only while paused')
  assert.equal(ctl.snapshot().elapsedMs, 2000)
  assert.equal(ctl.act({ act: 'resume' }).changed, true)
  assert.equal(ctl.act({ act: 'resume' }).changed, false, 'nothing to resume')
  c.add(1000)
  assert.equal(ctl.snapshot().elapsedMs, 3000)
  assert.equal(ctl.act(QUEEN).changed, true)
})

test('pause: none before the first move; the latest ready tab names the cover; New game ends it', () => {
  const { ctl } = make()
  ctl.sessions([tab('a', 'working'), tab('b', 'working')])
  assert.equal(ctl.sessions([tab('a', 'waiting'), tab('b', 'working')]), false, 'no move yet')
  ctl.act({ act: 'draw' })
  ctl.sessions([tab('a', 'working'), tab('b', 'working')])
  assert.equal(ctl.sessions([tab('a', 'waiting', { name: 'Docs' }), tab('b', 'working')]), true)
  assert.equal(ctl.sessions([tab('a', 'waiting', { name: 'Docs' }), tab('b', 'waiting', { title: 'Tests' })]), true)
  assert.deepEqual(ctl.snapshot().paused, { name: 'Tests' })
  assert.equal(ctl.pausedTab(), 'b')
  ctl.act({ act: 'new' })
  assert.equal(ctl.snapshot().paused, null)
  assert.equal(ctl.isPaused(), false)
  assert.equal(tabName({}), 'A Claude tab')
})

test('a win: Finish plays out, the clock stops, the stats count it and the best time is a record', () => {
  const { ctl, c } = make()
  ctl.act({ act: 'draw' })
  c.add(10000)
  assert.equal(ctl.snapshot().canFinish, false, 'the queen is still in the waste')
  ctl.act(QUEEN)
  assert.equal(ctl.snapshot().canFinish, true)
  const f = ctl.act({ act: 'finish' })
  assert.deepEqual(f, { changed: true, finish: true })
  assert.equal(ctl.finishing(), true)
  assert.equal(ctl.snapshot().canFinish, false, 'no second Finish while it plays')
  assert.equal(ctl.snapshot().canUndo, false)
  for (const m of [{ act: 'draw' }, { act: 'undo' }, { act: 'finish' }]) assert.equal(ctl.act(m).changed, false)
  c.add(2500)
  const r = playOut(ctl)
  assert.deepEqual(r.win, { draw: 1, seconds: 12, moves: 9 })
  const s = ctl.snapshot()
  assert.equal(s.status, 'won')
  assert.equal(s.running, false)
  assert.equal(s.finishing, false)
  assert.equal(s.record, true)
  assert.deepEqual(s.stats, { won: 1, best: 12 })
  c.add(5000)
  assert.equal(ctl.snapshot().elapsedMs, 12500, 'the clock stopped at the win')
  assert.equal(ctl.act({ act: 'undo' }).changed, false, 'no undo after a win')
  assert.equal(ctl.finishStep().changed, false)
})

test('a won game is never paused; a slower win is no record; a stored better time takes the record back', () => {
  const { ctl, c } = make()
  ctl.setStats({ won: { 1: 4 }, best: { 1: 5 } })
  ctl.act({ act: 'draw' })
  ctl.act(QUEEN)
  ctl.act({ act: 'finish' })
  c.add(9000)
  const r = playOut(ctl)
  assert.equal(r.win.seconds, 9)
  assert.equal(ctl.snapshot().record, false)
  assert.deepEqual(ctl.snapshot().stats, { won: 5, best: 5 })
  ctl.sessions([tab('t', 'working')])
  assert.equal(ctl.sessions([tab('t', 'waiting')]), false, 'no pause over the win')

  const fast = make()
  fast.ctl.act({ act: 'draw' })
  fast.ctl.act(QUEEN)
  fast.ctl.act({ act: 'finish' })
  fast.c.add(3000)
  playOut(fast.ctl)
  assert.equal(fast.ctl.snapshot().record, true)
  // Another window stored 2 s meanwhile: the host reads it back after the win.
  assert.equal(fast.ctl.setStats({ won: { 1: 7 }, best: { 1: 2 } }), true)
  assert.equal(fast.ctl.snapshot().record, false)
  assert.deepEqual(fast.ctl.snapshot().stats, { won: 7, best: 2 })
})

test('Finish never pauses, and New game stops it', () => {
  const { ctl } = make()
  ctl.sessions([tab('t', 'working')])
  ctl.act({ act: 'draw' })
  ctl.act(QUEEN)
  assert.equal(ctl.act({ act: 'finish' }).changed, true)
  assert.equal(ctl.sessions([tab('t', 'waiting')]), false)
  ctl.finishStep()
  assert.equal(ctl.act({ act: 'new' }).changed, true)
  assert.equal(ctl.finishing(), false)
  assert.equal(ctl.finishStep().changed, false)
  assert.equal(ctl.act({ act: 'finish' }).changed, false, 'the new deal cannot finish')
})

test('stats are per draw mode; stored counts only raise and stored times only lower', () => {
  const ctl = createController({ deal: nearWin })
  assert.equal(ctl.setStats({ won: { 1: 3, 3: 1 }, best: { 1: 100, 3: 300 } }), true)
  assert.equal(ctl.setStats({ won: { 1: 2 }, best: { 1: 200 } }), false)
  assert.equal(ctl.setStats({ won: { 1: 'x', 3: -1, 2: 99 }, best: { 1: NaN, 3: -5 } }), false)
  assert.equal(ctl.setStats(null), false)
  assert.deepEqual(ctl.snapshot().stats, { won: 3, best: 100 })
  ctl.act({ act: 'new', draw: 3 })
  assert.equal(ctl.snapshot().draw, 3)
  assert.deepEqual(ctl.snapshot().stats, { won: 1, best: 300 })
})

test('New game: the same draw mode, or the one asked; a junk mode changes nothing', () => {
  const ctl = createController({ rng: () => 0.3 })
  const g = ctl.snapshot().game
  assert.equal(ctl.act({ act: 'new' }).changed, true)
  assert.equal(ctl.snapshot().game, g + 1)
  assert.equal(ctl.snapshot().draw, 1)
  assert.equal(ctl.act({ act: 'new', draw: 3 }).changed, true)
  assert.equal(ctl.draw(), 3)
  for (const d of [2, '3', null, 0]) assert.equal(ctl.act({ act: 'new', draw: d }).changed, false)
  assert.equal(ctl.draw(), 3)
})

test('undo: counted as a change (seq), refused with nothing to undo; the moves go back', () => {
  const { ctl } = make()
  assert.equal(ctl.act({ act: 'undo' }).changed, false)
  ctl.act({ act: 'draw' })
  ctl.act(QUEEN)
  assert.equal(ctl.moves(), 2)
  const seq = ctl.snapshot().seq
  assert.equal(ctl.act({ act: 'undo' }).changed, true)
  assert.equal(ctl.snapshot().seq, seq + 1)
  assert.equal(ctl.moves(), 1)
  assert.deepEqual(ctl.snapshot().waste, [card('c', 12)])
  ctl.act({ act: 'undo' })
  assert.equal(ctl.canUndo(), false)
  assert.equal(ctl.untouched(), false, 'undoing back to the deal keeps the clock started')
})

test('the four-colour deck is in the snapshot', () => {
  const ctl = createController()
  assert.equal(ctl.snapshot().four, false)
  assert.equal(ctl.setFour(true), true)
  assert.equal(ctl.setFour(true), false)
  assert.equal(ctl.snapshot().four, true)
  assert.equal(ctl.setFour('yes'), true, 'only true is on')
  assert.equal(ctl.snapshot().four, false)
})

test('junk actions change nothing', () => {
  const { ctl } = make()
  const before = JSON.stringify(ctl.snapshot())
  for (const m of [
    null,
    'draw',
    5,
    {},
    { act: 'nope' },
    { act: 'move' },
    { act: 'move', src: 'x', dest: 'y' },
    { act: 'move', src: { from: 'waste', s: 'c', r: 12 }, dest: { to: 'found' } }, // the queen is not drawn yet
    { act: 'finish' },
    { act: 'resume' },
    { act: 'undo' },
    { act: '__proto__' },
  ]) {
    assert.equal(ctl.act(m).changed, false, JSON.stringify(m))
  }
  assert.equal(JSON.stringify(ctl.snapshot()), before)
})
