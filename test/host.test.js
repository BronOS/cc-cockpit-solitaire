'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fakeCtx } = require('./fake-ctx.js')
const rules = require('../lib/rules.js')

const root = path.join(__dirname, '..')
const host = require('../dist/host.js')

const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: '/proj', notes: [], files: [], ...extra })
const settle = () => new Promise((resolve) => setImmediate(resolve))
const card = (s, r, up = true) => ({ s, r, up })
const upTo = (s, r) => Array.from({ length: r }, (_, i) => card(s, i + 1))
/** One draw from Finish (see test/controller.test.js): draw, send the queen home, Finish plays the last 7. */
const nearWin = (draw) => ({
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

const realNewGame = rules.newGame
test.afterEach(() => {
  host.deactivate()
  rules.newGame = realNewGame
})

async function started(opts) {
  const f = fakeCtx(opts)
  host.activate(f.ctx)
  await settle()
  return f
}
/** Started on the near-win deal (the controller deals with rules.newGame, read when it is made). */
async function nearWinStarted(opts) {
  rules.newGame = nearWin
  const f = await started(opts)
  await f.send({ hello: 1, visible: true })
  return f
}
/** Lets Finish step to the end (70 ms a card, 7 cards). */
async function finishPlays(t) {
  for (let k = 0; k < 10; k++) {
    t.mock.timers.tick(70)
    await settle()
  }
  for (let k = 0; k < 5; k++) await settle()
}

test('hello is answered with the state; the deal and its moves live in the host', async () => {
  const f = await started()
  await f.send({ hello: 1, visible: true }, 'web:3')
  let s = f.lastState()
  assert.equal(s.status, 'play')
  assert.equal(s.tab.flat().length, 28)
  assert.equal(s.stock.length, 24)
  assert.ok(s.stock.every((x) => x.s === undefined), 'the stock is not revealed')
  await f.send({ act: 'draw' })
  s = f.lastState()
  assert.equal(s.waste.length, 1)
  assert.equal(s.moves, 1)
  assert.equal(f.posts.at(-1).options, undefined, 'state changes go to every view')
  const n = f.posts.length
  await f.send({ act: 'move', src: { from: 'waste', s: 'x', r: 1 }, dest: { to: 'found' } })
  assert.equal(f.posts.length, n, 'a refused move posts nothing')
})

test('header: New game, Undo, the draw switch; the mode and the moves as its text; Undo greyed out with nothing to undo', async () => {
  const f = await started()
  let h = f.headers.at(-1)
  assert.equal(h.meta, 'Draw 1')
  assert.deepEqual(h.actions.map((a) => a.id), ['new', 'undo', 'draw'])
  assert.equal(h.actions[0].icon, 'refresh')
  for (const a of h.actions.slice(1)) assert.ok(fs.existsSync(path.join(root, a.icon)), `${a.id}: the icon is a file of the plugin`)
  assert.equal(h.actions[1].disabled, true)
  assert.equal(h.actions[2].icon, 'icons/draw3.svg', 'it shows the mode it switches to')
  assert.match(h.actions[2].title, /Draw 3/)

  await f.send({ act: 'draw' })
  h = f.headers.at(-1)
  assert.equal(h.meta, 'Draw 1 · 1 move')
  assert.equal(h.actions[1].disabled, false)
  await f.send({ act: 'draw' })
  assert.equal(f.headers.at(-1).meta, 'Draw 1 · 2 moves')

  await f.click('undo')
  assert.equal(f.lastState().moves, 1, 'Undo takes the draw back')
  await f.click('new')
  assert.equal(f.lastState().moves, 0, 'New game deals again')
  assert.equal(f.headers.at(-1).actions[1].disabled, true)
  assert.equal(f.headers.at(-1).meta, 'Draw 1')

  const n = f.headers.length
  await f.send({ hello: 1 })
  assert.equal(f.headers.length, n, 'an unchanged header is not set again')
})

test('the draw switch deals a new game in the other mode and remembers it app-wide', async () => {
  const f = await started()
  await f.send({ act: 'draw' })
  const game = f.lastState().game
  await f.click('draw')
  let s = f.lastState()
  assert.equal(s.draw, 3)
  assert.equal(s.game, game + 1)
  assert.equal(s.moves, 0)
  assert.equal(await f.ctx.appStorage.get('draw'), 3)
  assert.equal(f.headers.at(-1).meta, 'Draw 3')
  assert.equal(f.headers.at(-1).actions[2].icon, 'icons/draw1.svg')
  await f.send({ act: 'draw' })
  assert.equal(f.lastState().waste.length, 3, 'three cards a draw')
  host.deactivate()

  const g = fakeCtx()
  await g.ctx.appStorage.set('draw', 3)
  host.activate(g.ctx)
  await g.send({ hello: 1 })
  s = g.lastState()
  assert.equal(s.draw, 3, 'the mode picked last comes back')
  assert.equal(g.headers.at(-1).meta, 'Draw 3')
  // The page cannot switch the mode itself (only the title bar does, which stores it).
  const n = g.posts.length
  await g.send({ act: 'new', draw: 1 })
  assert.equal(g.posts.length, n)
})

test('pause: a working tab turning waiting while playing pauses and names it; Go to the tab focuses it', async () => {
  const f = await started({ sessions: [tab('t1', 'working', { title: 'Fix the scroll test' })] })
  await f.send({ hello: 1, visible: true })
  await f.send({ act: 'draw' })
  assert.equal(f.lastState().running, true)
  f.setSessions([tab('t1', 'waiting', { title: 'Fix the scroll test' })])
  assert.deepEqual(f.lastState().paused, { name: 'Fix the scroll test' })
  assert.equal(f.lastState().running, false, 'the clock stops')
  assert.equal(f.headers.at(-1).actions[1].disabled, true, 'Undo is greyed out while paused')

  const n = f.posts.length
  await f.send({ act: 'draw' })
  await f.send({ act: 'undo' })
  await f.click('undo')
  assert.equal(f.posts.length, n, 'no moves while paused')

  await f.send({ act: 'goto' }, 'web:1')
  assert.deepEqual(f.focused, ['t1'])
  assert.equal(f.posts.length, n, 'a focus that worked posts nothing')
  assert.equal(f.lastState().paused.name, 'Fix the scroll test', 'Go to the tab does not resume')

  await f.send({ act: 'resume' })
  assert.equal(f.lastState().paused, null)
  assert.equal(f.lastState().running, true)
  assert.equal(f.headers.at(-1).actions[1].disabled, false)
})

test('no pause before the first move; Go to the tab on a closed tab tells only that view', async () => {
  const f = await started({ sessions: [tab('t1', 'working')] })
  f.setSessions([tab('t1', 'waiting')])
  await f.send({ hello: 1 })
  assert.equal(f.lastState().paused, null)

  await f.send({ act: 'draw' })
  f.setSessions([tab('t1', 'working')])
  f.setSessions([tab('t1', 'waiting')])
  assert.ok(f.lastState().paused)
  f.setSessions([])
  await f.send({ act: 'goto' }, 'web:2')
  assert.deepEqual(f.posts.at(-1), { panelId: 'solitaire', message: { notice: 'That Claude tab is closed.' }, options: { view: 'web:2' } })
})

test('the clock stops when the panel is hidden in every view, and when its page is out of sight', async () => {
  const f = await started()
  await f.send({ hello: 1, visible: true })
  await f.send({ act: 'draw' })
  assert.equal(f.lastState().running, true)
  await f.send({ hello: 1, visible: true }, 'web:1')
  f.viewGone('desktop')
  assert.equal(f.lastState().running, true, 'the browser still shows it')
  f.viewGone('web:1')
  assert.equal(f.lastState().running, false, 'hidden everywhere: the clock stops')
  await f.send({ hello: 1, visible: true })
  assert.equal(f.lastState().running, true, 'shown again')
  await f.send({ act: 'seen', visible: false })
  assert.equal(f.lastState().running, false, 'the page went out of sight (a minimized window)')
  await f.send({ act: 'seen', visible: true })
  assert.equal(f.lastState().running, true)
})

test('without ctx.views the page saying it is out of sight still stops the clock', async () => {
  const f = await started({ views: false })
  await f.send({ hello: 1, visible: true })
  await f.send({ act: 'draw' })
  await f.send({ act: 'seen', visible: false })
  assert.equal(f.lastState().running, false)
})

test('a win: Finish plays the cards home one by one, then the stats are stored app-wide', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await nearWinStarted()
  await f.send({ act: 'draw' })
  await f.send(QUEEN)
  assert.equal(f.lastState().canFinish, true)
  await f.send({ act: 'finish' })
  assert.equal(f.lastState().finishing, true)
  const before = f.posts.length
  await finishPlays(t)
  const s = f.lastState()
  assert.equal(s.status, 'won')
  assert.equal(s.moves, 9)
  assert.equal(f.posts.length - before >= 7, true, 'a state per card home')
  assert.equal(s.record, true)
  assert.equal(await f.ctx.appStorage.get('won:1'), 1)
  assert.equal(typeof (await f.ctx.appStorage.get('best:1')), 'number')
  assert.deepEqual(s.stats, { won: 1, best: await f.ctx.appStorage.get('best:1') })
  assert.equal(await f.ctx.appStorage.get('won:3'), undefined, 'per draw mode')
})

test('a win counts on top of other windows and keeps a better stored time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  rules.newGame = nearWin
  const f = fakeCtx()
  await f.ctx.appStorage.set('won:1', 10)
  host.activate(f.ctx)
  await f.send({ hello: 1, visible: true })
  assert.deepEqual(f.lastState().stats, { won: 10, best: null })
  // Another window stores its count and a 0 s best after this one read the store at start.
  await f.ctx.appStorage.set('won:1', 12)
  await f.ctx.appStorage.set('best:1', 0)
  await f.send({ act: 'draw' })
  await f.send(QUEEN)
  await f.send({ act: 'finish' })
  await finishPlays(t)
  assert.equal(await f.ctx.appStorage.get('won:1'), 13)
  assert.equal(await f.ctx.appStorage.get('best:1'), 0)
  const s = f.lastState()
  assert.deepEqual(s.stats, { won: 13, best: 0 })
  assert.equal(s.record, false)
})

test('without ctx.appStorage the records and the draw mode go to ctx.storage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await nearWinStarted({ appStorage: false })
  await f.send({ act: 'draw' })
  await f.send(QUEEN)
  await f.send({ act: 'finish' })
  await finishPlays(t)
  assert.equal(await f.ctx.storage.get('won:1'), 1)
  await f.click('draw')
  assert.equal(await f.ctx.storage.get('draw'), 3)
})

test('the four-colour deck follows the app setting', async () => {
  const f = await started({ settings: { fourColour: true } })
  await f.send({ hello: 1 })
  assert.equal(f.lastState().four, true)
  f.setSettings({ fourColour: false })
  assert.equal(f.lastState().four, false)
  const n = f.posts.length
  f.setSettings({ fourColour: false })
  assert.equal(f.posts.length, n, 'no change, no post')
})

test('New game from the title bar stops a Finish in progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await nearWinStarted()
  await f.send({ act: 'draw' })
  await f.send(QUEEN)
  await f.send({ act: 'finish' })
  t.mock.timers.tick(70)
  await settle()
  await f.click('new')
  const s = f.lastState()
  await finishPlays(t)
  assert.equal(f.lastState().seq, s.seq, 'no more steps')
  assert.equal(f.lastState().status, 'play')
})

test('junk from the page is ignored', async () => {
  const f = await started()
  const n = f.posts.length
  for (const m of [
    null,
    'x',
    5,
    {},
    { act: 'move' },
    { act: 'move', src: { from: 'tab', col: 0, i: 0, s: 'zz', r: 1 }, dest: { to: 'found' } },
    { act: 'new', draw: 2 },
    { act: 'goto' },
    { act: 'resume' },
    { act: 'finish' },
    { act: 'undo' },
    { act: 'seen' },
    { act: 'toString' },
  ]) {
    await f.send(m)
  }
  assert.equal(f.posts.length, n)
  await f.click('nope')
  assert.equal(f.posts.length, n)
})

test('the plugin is harmless: no exec, network, secrets, overlays or session writes in its code', () => {
  const files = ['dist/host.js', 'lib/rules.js', 'lib/pause.js', 'lib/controller.js', 'panels/solitaire.js', 'panels/view.js']
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const bad of [
      'ctx.exec',
      'ctx.processes',
      'ctx.secrets',
      'ctx.oauth',
      'ctx.overlay',
      'ctx.openExternal',
      'sessions.send',
      'sessions.open',
      'sessions.close',
      'sessions.rename',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      "require('node:child_process')",
      "require('child_process')",
      'localStorage',
      'alert(',
      'innerHTML',
    ]) {
      assert.equal(text.includes(bad), false, `${file} uses ${bad}`)
    }
  }
})

test('the manifest: id, one right-zone panel with an svg icon, one app setting, files present, no cli, skills or access', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
  assert.equal(m.id, 'bronos.solitaire')
  assert.equal(m.name, 'Solitaire')
  assert.equal(m.api, 1)
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(m.contributes), ['panels', 'settings'])
  assert.deepEqual(Object.keys(m.contributes.settings), ['app'], 'no project settings')
  assert.deepEqual(m.contributes.settings.app.properties.fourColour, {
    type: 'boolean',
    title: 'Four-colour deck',
    description: m.contributes.settings.app.properties.fourColour.description,
    default: false,
  })
  assert.equal(m.access, undefined)
  assert.equal(m.services, undefined)
  const [p] = m.contributes.panels
  assert.equal(p.id, 'solitaire')
  assert.equal(p.title, 'Solitaire')
  assert.equal(p.defaultZone, 'right')
  assert.match(p.icon, /\.svg$/)
  for (const file of [m.main, p.entry, p.icon]) assert.ok(fs.existsSync(path.join(root, file)), file)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, m.version)
})

test('the page: no inline script or handlers, relative URLs only, the SDK first, the rules before the page', () => {
  const html = fs.readFileSync(path.join(root, 'panels/solitaire.html'), 'utf8')
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /src="/, 'every script has a src')
    assert.equal(m[2].trim(), '', 'no inline script')
  }
  assert.equal(/\son[a-z]+=/i.test(html), false, 'no inline event handlers')
  assert.equal(/(src|href)="\//.test(html), false, 'no root-absolute URL')
  assert.ok(html.indexOf('src="../__sdk/panel.js"') < html.indexOf('src="../lib/rules.js"'))
  assert.ok(html.indexOf('src="../lib/rules.js"') < html.indexOf('src="view.js"'))
  assert.ok(html.indexOf('src="view.js"') < html.indexOf('src="solitaire.js"'))
  assert.equal(/<form\b/i.test(html), false)
  // Plugin pages have no reset: without this a class with a display shows a hidden element (Mines' empty menu).
  const css = fs.readFileSync(path.join(root, 'panels/solitaire.css'), 'utf8')
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
  // Each page script is one IIFE: a top-level const that clashes with a window property kills a classic script.
  for (const file of ['panels/solitaire.js', 'panels/view.js', 'lib/rules.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.equal(/^(const|let|var|function|class)\s/m.test(text), false, `${file} declares nothing at its top level`)
  }
})
