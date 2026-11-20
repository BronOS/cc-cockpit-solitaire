'use strict'
// Which Claude tabs just became ready: a tab of this project window that was `working` and now is `waiting`
// (Claude finished its turn and waits for input). Pure; fed the whole `ctx.sessions` list on every change.
//
// Only a transition counts, never a state: a tab that was already waiting when the game started, or one first
// seen waiting (no earlier status known), does not pause a game. The list comes throttled (at most 4 a second),
// so a turn shorter than that can be missed; a missed pause costs nothing.

const FROM = 'working'
const TO = 'waiting'

/** What the cover calls the tab: the person's name for it, else Claude's topic, else a plain phrase. */
function tabName(session) {
  for (const v of [session && session.name, session && session.title]) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 120)
  }
  return 'A Claude tab'
}

function createReadyWatch() {
  /** tabId -> the status seen last. Tabs that left the list are forgotten. */
  let last = new Map()
  return {
    /** The tabs that went from working to waiting since the last list, in list order: `[{ tabId, name }]`. */
    observe(list) {
      const next = new Map()
      const ready = []
      for (const s of Array.isArray(list) ? list : []) {
        if (!s || typeof s.tabId !== 'string' || typeof s.status !== 'string') continue
        if (last.get(s.tabId) === FROM && s.status === TO) ready.push({ tabId: s.tabId, name: tabName(s) })
        next.set(s.tabId, s.status)
      }
      last = next
      return ready
    },
  }
}

module.exports = { createReadyWatch, tabName }
