# Claude AI Usage Widget

A Tampermonkey userscript for [claude.ai](https://claude.ai) that displays a floating usage stats widget and suppresses the chat-box near-limit warning banner.

## Features

- **Floating widget** — compact, draggable capsule pinned to the right edge showing 5-hour, 7-day, and monthly spend usage
- **Auto-refresh** — polls the usage API every 10 minutes; manual refresh button available
- **Warning suppression** — hides the "You've used 75% of your limit" banner in the chat box
- **Visual feedback** — widget tints yellow when approaching limits; colour-coded fetch states
- **Minimizable** — collapses to a small circle; middle-click the circle to refresh

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Create a new script and paste in the contents of [`src/main.js`](src/main.js)
3. Save and navigate to [claude.ai](https://claude.ai)

## Widget

```
5H: 12%
7D: 43%
M$: 1.20
  ↻ −
```

- `5H` — 5-hour utilization
- `7D` — 7-day utilization
- `M$` — monthly extra-usage spend (dollars)
- Hover the widget for last-updated time and reset timestamps
- Drag vertically to reposition (persisted across page loads)

## Development

Requires Node.js (for type checking only — no build step).

```sh
npm install
```

The `jsconfig.json` sets up Tampermonkey type definitions so the TypeScript language server can type-check `src/main.js`.

## License

[MIT](LICENSE)
