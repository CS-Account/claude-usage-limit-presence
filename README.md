# Claude AI Usage Widget

A Tampermonkey userscript for [claude.ai](https://claude.ai) that displays a floating usage stats widget and suppresses the chat-box near-limit warning banner.

## Features

- **Floating widget** — slim vertical panel pinned to the right edge showing 5-hour, 7-day, and monthly spend usage
- **Auto-refresh** — polls the usage API every 2 minutes; manual refresh button available
- **Warning suppression** — hides the "You've used 75% of your limit" banner in the chat box
- **Visual feedback** — values tint yellow when approaching limits; colour-coded fetch states
- **Tooltips** — hover each section for usage %, time till reset, full reset datetime, and elapsed % through the period

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Create a new script and paste in the contents of [`src/main.js`](src/main.js)
3. Save and navigate to [claude.ai](https://claude.ai)

## Widget

```
 5h
 42%
 5h12m
─────
 7d
 61%
 2d6h
─────
 MS
 3.50
  ↻
```

- `5h` — 5-hour utilization, with countdown to reset
- `7d` — 7-day utilization, with countdown to reset
- `MS` — monthly extra-usage spend in dollars
- Hover a section for: usage %, time till reset, full reset datetime (7d includes weekday), and elapsed % through the period
- Hover the refresh button for last refresh time and fetch status
- Drag vertically to reposition (persisted across page loads)

## Development

Requires Node.js (for type checking only — no build step).

```sh
npm install
```

The `jsconfig.json` sets up Tampermonkey type definitions so the TypeScript language server can type-check `src/main.js`.

## License

[MIT](LICENSE)
