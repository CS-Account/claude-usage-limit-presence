# TODO

## Done

- Floating widget pinned to the right edge with 5H / 7D / M$ stat rows
- Fetches usage from `claude.ai/api/organizations/{id}/usage` using org ID from cookie
- Auto-refresh every 10 minutes; manual refresh button
- Minimizable to a small circle; middle-click circle to refresh
- Vertically draggable; position persisted in `localStorage`
- Hover tooltip on widget and minimized circle showing reset times and last refresh
- Yellow pending tint while org ID has not yet been found
- Colour feedback for fetch states: loading (dim), failed (muted)
- Colour feedback for usage thresholds: >75% 5H (yellow), >75% 7D (darker yellow)
- Monthly spend over-limit colour on M$ row
- Warning banner suppression via MutationObserver + XPath
- MIT license, README, devcontainer with Tampermonkey type definitions

## Not yet tested / TODO

- Colour threshold behaviour with real >75% utilization values
- Warning suppression XPath — may not match if claude.ai updates their markup
- Warning suppression actually working end-to-end (never triggered during dev)
- Edge cases in API response: `extra_usage: null`, missing `five_hour`/`seven_day`, non-200 errors beyond basic throw
- Org ID switching (e.g. switching between organizations mid-session)
- Browser compatibility beyond Firefox (primary target)
