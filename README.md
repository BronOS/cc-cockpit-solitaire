# Solitaire

A cc-cockpit plugin (`bronos.solitaire`): classic seven-column patience (Klondike) in a panel, to play while Claude
works. When a Claude tab of the window finishes its turn and waits for you, the game pauses and tells you which tab it
is.

It is a harmless game: no commands, no network, no secrets, no overlays, and one setting (the four-colour deck). It
reads the window's Claude tab statuses and names, and its one action on a tab is to show it when you click **Go to the
tab**. It never types into or sends anything to a session.

## Install

From a checkout: `ccc plugin link <path to this repo>`, then Allow it in the app window. The **Solitaire** panel opens
in the right zone (move it like any panel).

## How to play

Build each suit up from ace to king on the four foundations (top right). The seven columns build down, alternating red
and black; only a king (or a run starting with one) goes on an empty column.

- **Tap** a card and it goes to the best place on its own: home to its foundation first, then onto a column with cards
  (looking rightward from its own column), then onto an empty column. A king that already heads its column never hops
  to another empty one. When it fits nowhere, it shakes.
- **Drag** a card, with the cards on it, to pick the place yourself; the place it would land on is outlined in green.
  Dropped where it does not fit (or dragged out of the panel), it goes back.
- **Tap the deck** (top left) to draw; Space does it too. An empty deck shows ↻: tapping it turns the drawn cards back
  over, as often as you like.
- **Draw 1 or Draw 3**: the button with the card(s) in the panel's title bar switches the mode and deals a new game. In
  Draw 3 the three cards drawn last are fanned, and only the top one plays. The mode you picked comes back next time.
- **Undo** (the curved arrow in the title bar, or U) takes back moves and draws, one at a time, as far back as you
  like; it is greyed out when there is nothing to undo or the game is paused. **New game** (the circular arrow, or N)
  deals again.
- Turning over the card under a moved one is part of that move (one Undo takes both back).
- **Finish** appears once the deck is used up and every card in the columns is face up: it sends every card home, one
  after another.
- Winning shows **You won!** with your moves and time, your best time in that draw mode (or that this one is a new
  best) and how many games you have won in it. Records are kept for every project window, across restarts.
- The bar shows the moves and the time. The time runs from your first move and stands while the game is paused, while
  the panel is hidden or closed, and while its window or browser tab is out of sight.
- Keys work only after a click into the board (it has focus): U undo, N new game, Space draw, Enter presses a cover's
  main button (Resume game, New game). Other keys go on to the app.

The cards scale with the panel's width; a long column closes up to fit the panel's height, always leaving each covered
card's rank and suit in view. The felt and the card faces have their own colours for light and dark themes.

### Four-colour deck

Every card prints its rank and its suit symbol in the corner and the symbol large, so no suit rests on telling two
colours apart. For more help at a glance, Settings › Plugins › Solitaire has **Four-colour deck**: diamonds turn blue
and clubs green (hearts stay red, spades black). It is a plugin setting rather than a switch in the panel, as the app
keeps every setting in Settings; the gear in the panel's title bar opens it.

## The Claude pause

While a game is in play (one move made, not won, Finish not running), a Claude tab of the same window that was
**working** and becomes **waiting for input** pauses it: the clock stops, the board takes no moves (Undo neither), and a
cover says **Claude is ready** with the tab's name (the name you gave it, else Claude's topic for it). **Resume game**
goes on; **Go to the tab** shows that tab and leaves the game paused for when you come back. The board keeps the
keyboard, so a Space meant for the deck does not resume the game by accident.

- Only a change seen while you play pauses: a tab that was already waiting, or one that finished before your first move,
  does not.
- With several tabs, the cover names the latest one to become ready.
- A tab that stops to ask for a permission (or a question) is not "ready" and does not pause the game.
- The game lives in the plugin's host, not in the panel page: a paused game stays paused while the panel is hidden or
  closed. Every view of the window (the desktop and a web access browser) shows the same game.
- A restart of the plugin host (the app restarting, or a plugin being enabled, linked or updated in the project) ends
  the game in progress; records are kept.

How it knows: `ctx.sessions.onChange` (the window's Claude tabs with their status, on every change) and one
`ctx.sessions.list()` at start; **Go to the tab** is `ctx.sessions.focus`. The clock learns that the panel is gone from
`ctx.views.onChange` and that a page is out of sight from the page itself.

## Development

Plain JavaScript, no build step: `dist/host.js` wires `lib/controller.js` (the game, its clock, Finish, the pause and
the records) to the plugin API; `lib/rules.js` is the game's rules and `lib/pause.js` the working-to-waiting rule, both
pure. The page loads `lib/rules.js` too, to find a tap's target and a drop's fit at once on the view the host sent
(face-down cards blanked); the host checks every move again. `panels/` is the page (`view.js` its pure helpers,
`solitaire.js` the drawing and the input). A face-up card's element stays with the card, so a move slides it from where
it was drawn.

`npm test` runs the `node:test` suites: the rules, the controller with a fake clock, the host with a fake `ctx`, and the
page's helpers.

## License

MIT
