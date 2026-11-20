'use strict'
// A fake plugin `ctx` with the parts of cc-cockpit's API (`ccc guide api`) this plugin uses: panels.post /
// onMessage (with `from: { view, access }`) / header / onAction, sessions.list / onChange (the whole list each time) /
// focus, views.onChange, settings and onSettingsChange, appStorage (with increment) and storage (async, JSON values),
// log. It records posts, headers and focus calls, and has no exec, network, secrets, overlays or sessions.send: a host
// call to any of them throws, which the host test relies on.

const fs = require('node:fs')
const path = require('node:path')

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))
const PANELS = new Set(MANIFEST.contributes.panels.map((p) => p.id))

function fakeStore({ increment = true } = {}) {
  const map = new Map()
  const store = {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: async (key, value) => {
      map.set(key, structuredClone(value))
    },
    delete: async (key) => {
      map.delete(key)
    },
    keys: async () => [...map.keys()],
  }
  if (increment) {
    store.increment = async (key, by = 1) => {
      const v = map.has(key) ? map.get(key) : 0
      if (typeof v !== 'number') throw new TypeError(`${key} is not a number`)
      map.set(key, v + by)
      return v + by
    }
  }
  return store
}

function fakeCtx({ sessions = [], appStorage = true, views = true, settings = { fourColour: false } } = {}) {
  const posts = [] // { panelId, message, options }
  const focused = []
  const logs = []
  const panelListeners = new Map()
  const sessionListeners = new Set()
  let list = sessions
  const forbidden = (name) => () => {
    throw new Error(`Solitaire must not call ${name}`)
  }
  const viewListeners = new Set()
  const settingsListeners = new Set()

  const headers = []
  const actionListeners = new Map()
  const ctx = {
    api: 1,
    pluginId: MANIFEST.id,
    projectDir: '/proj',
    settings: Object.freeze({ project: {}, app: Object.freeze({ ...settings }) }),
    onSettingsChange(fn) {
      settingsListeners.add(fn)
      return () => settingsListeners.delete(fn)
    },
    log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    storage: fakeStore({ increment: false }),
    appStorage: appStorage ? fakeStore() : undefined,
    panels: {
      post(panelId, message, options) {
        if (!PANELS.has(panelId)) throw new TypeError(`unknown panel ${panelId}`)
        JSON.stringify(message)
        posts.push({ panelId, message: structuredClone(message), options })
      },
      onMessage(panelId, fn) {
        if (!PANELS.has(panelId)) throw new TypeError(`unknown panel ${panelId}`)
        panelListeners.set(panelId, fn)
        return () => panelListeners.delete(panelId)
      },
      // The guide's limits: up to 3 actions, ids unique, icons built in or an .svg of the plugin.
      header(panelId, spec) {
        if (!PANELS.has(panelId)) throw new TypeError(`unknown panel ${panelId}`)
        if (spec && (spec.actions || []).length > 3) throw new TypeError('too many actions')
        headers.push(structuredClone(spec))
      },
      onAction(panelId, fn) {
        if (!PANELS.has(panelId)) throw new TypeError(`unknown panel ${panelId}`)
        actionListeners.set(panelId, fn)
        return () => actionListeners.delete(panelId)
      },
    },
    sessions: {
      list: async () => structuredClone(list),
      onChange(fn) {
        sessionListeners.add(fn)
        return () => sessionListeners.delete(fn)
      },
      focus: async (tabId) => {
        focused.push(tabId)
        return list.some((s) => s.tabId === tabId)
      },
      send: forbidden('sessions.send'),
      open: forbidden('sessions.open'),
    },
    views: views
      ? {
          access: () => 'owner',
          onChange(fn) {
            viewListeners.add(fn)
            return () => viewListeners.delete(fn)
          },
        }
      : undefined,
    exec: forbidden('exec'),
    secrets: { get: forbidden('secrets.get'), set: forbidden('secrets.set') },
    overlay: { open: forbidden('overlay.open'), start: forbidden('overlay.start') },
    openExternal: forbidden('openExternal'),
  }

  return {
    ctx,
    posts,
    headers,
    /** A click on a header action; resolves when the host's listener settled. */
    click: (id) => actionListeners.get('solitaire')(id),
    focused,
    logs,
    /** What the page in `view` sends; resolves when the host's listener settled. */
    send: (message, view = 'desktop') => panelListeners.get('solitaire')(message, { view, access: 'owner' }),
    /** The app's next sessions list (also what a later `list()` answers). */
    setSessions(next) {
      list = next
      for (const fn of sessionListeners) fn(structuredClone(next))
    },
    /** A view's last page went (the panel hidden or closed there), as ctx.views tells it. */
    viewGone(view) {
      for (const fn of viewListeners) fn({ view, access: undefined })
    },
    /** A save of the plugin's app settings. */
    setSettings(app) {
      this.ctx.settings = Object.freeze({ project: {}, app: Object.freeze({ ...app }) })
      for (const fn of settingsListeners) fn(this.ctx.settings)
    },
    lastState: () => {
      for (let i = posts.length - 1; i >= 0; i--) if (posts[i].message.state) return posts[i].message.state
      return undefined
    },
  }
}

module.exports = { fakeCtx }
