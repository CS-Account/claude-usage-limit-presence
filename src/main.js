// ==UserScript==
// @name         Claude AI Usage Widget
// @namespace    claude-ai-usage-widget
// @version      0.1.1
// @description  Floating usage stats widget for claude.ai; suppresses the chat-box usage warning.
// @author       CS-Account
// @match        https://claude.ai/*
// @grant        none
// ==/UserScript==


'use strict';

(() => {
    /**
     * XPath to locate the near-limit warning banner in the chat box.
     * Matches the outermost ancestor div (px-3 md:px-2) containing a usage-limit span.
     * Deliberately avoids matching the exact percentage so it works if the threshold changes.
     * @type {string}
     */
    const WARNING_XPATH =
        "//span[contains(., '% of your') and contains(., 'limit')]" +
        "/ancestor::div[contains(@class,'px-3') and contains(@class,'md:px-2')]";

    /** Auto-refresh interval (10 min). @type {number} */
    const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

    /** Debounce delay for org-ID search after page mutations (ms). @type {number} */
    const DEBOUNCE_DELAY_MS = 500;

    /** localStorage key for persisting the widget's vertical position. @type {string} */
    const POSITION_STORAGE_KEY = 'claude-usage-panel-vertical-position-px';

    /** @type {string|null} */
    let organizationId = null;

    /** @type {Date|null} */
    let lastUpdated = null;

    /** @type {boolean} */
    let pollingStarted = false;

    /** @type {boolean} */
    let isMinimized = false;

    /* --- Widget element refs --- */
    /** @type {HTMLElement|null} */ let widget = null;
    /** @type {HTMLElement|null} */ let fiveHourRow = null;
    /** @type {HTMLElement|null} */ let sevenDayRow = null;
    /** @type {HTMLElement|null} */ let monthlySpendRow = null;
    /** @type {HTMLElement|null} */ let refreshButtonElement = null;
    /** @type {HTMLElement|null} */ let minimizeButtonElement = null;
    /** @type {HTMLElement|null} */ let buttonRowElement = null;

    /* ─────────────────────────── helpers ─────────────────────────── */

    /**
     * Hides the chat-box usage-warning element if present, via a single XPath query.
     * @returns {void}
     */
    function hideWarning() {
        const xpathResult = document.evaluate(
            WARNING_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const warningNode = /** @type {HTMLElement|null} */ (xpathResult.singleNodeValue);
        if (warningNode) warningNode.style.display = 'none';
    }

    /**
     * Extracts the active organization UUID from the lastActiveOrg cookie.
     * @returns {string|null}
     */
    function findOrganizationId() {
        return document.cookie.split('; ').find(cookie => cookie.startsWith('lastActiveOrg='))?.split('=')[1] ?? null;
    }

    /**
     * Formats a utilization percentage for display.
     * @param {number|null|undefined} utilization - Utilization value (0–100).
     * @returns {string} e.g. "42%" or "--"
     */
    const formatPercent = (utilization) =>
        utilization != null && isFinite(/** @type {number} */(utilization))
            ? Math.round(/** @type {number} */(utilization)) + '%'
            : '--';

    /**
     * Formats a credit value (cents) as a dollar amount string (no sign).
     * @param {number|null|undefined} cents
     * @returns {string} e.g. "3.50" or "--"
     */
    const formatDollars = (cents) =>
        cents != null && isFinite(/** @type {number} */(cents))
            ? (/** @type {number} */ (cents) / 100).toFixed(2)
            : '--';

    /**
     * Formats a reset timestamp string in local time as "YYYY-MM-DD HH:MM:SS ±HHMM".
     * @param {string|null|undefined} isoTimestamp
     * @returns {string}
     */
    function formatResetTime(isoTimestamp) {
        if (!isoTimestamp) return '--';
        const date = new Date(isoTimestamp);
        if (isNaN(date.getTime())) return '--';
        const zeroPad = (/** @type {number} */ number) => String(number).padStart(2, '0');
        const timezoneOffsetMinutes = -date.getTimezoneOffset();
        const offsetSign = timezoneOffsetMinutes >= 0 ? '+' : '-';
        const absoluteOffsetMinutes = Math.abs(timezoneOffsetMinutes);
        return date.getFullYear() + '-' + zeroPad(date.getMonth() + 1) + '-' + zeroPad(date.getDate()) + ' ' +
            zeroPad(date.getHours()) + ':' + zeroPad(date.getMinutes()) + ':' + zeroPad(date.getSeconds()) + ' ' +
            offsetSign + zeroPad(Math.floor(absoluteOffsetMinutes / 60)) + zeroPad(absoluteOffsetMinutes % 60);
    }

    /* ─────────────────────────── widget ─────────────────────────── */

    /**
     * Injects minimal CSS and builds the widget DOM, then attaches it to body.
     * @returns {void}
     */
    function createWidget() {
        const styleElement = document.createElement('style');
        styleElement.textContent = `
        /* Widget container — fixed to the right edge, vertically centred */
        #claude-usage-panel {
            position: fixed;
            right: 6px;
            top: 75%;
            transform: translateY(-50%);
            z-index: 9999;

            display: flex;
            flex-direction: column;
            gap: 5px;
            padding: 9px 11px;
            border-radius: 27px;

            background: rgba(20, 20, 20, 0.52);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            border: 1px solid rgba(255, 255, 255, 0.15);

            color: rgba(255, 255, 255, 0.88);
            font: 600 15px / 1.4 monospace;

            user-select: none;
            cursor: default;
            transition: background 0.3s, border-radius 0.3s, padding 0.3s;
        }

        /* Yellow tint while waiting for the org cookie to appear */
        #claude-usage-panel.pending-organization {
            background: rgba(180, 140, 0, 0.6);
        }

        /* Minimized — collapses to a fixed-size circle showing only the minimize button */
        #claude-usage-panel.minimized {
            padding: 0;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            gap: 0;
            align-items: center;
            justify-content: center;
        }

        #claude-usage-panel.minimized .stat-row,
        #claude-usage-panel.minimized #refresh-button {
            display: none;
        }

        #claude-usage-panel.minimized #button-row {
            gap: 0;
            margin-top: 0;
        }

        #claude-usage-panel.minimized #minimize-button {
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            padding: 0;
            background: transparent;
            border-radius: 50%;
        }

        #claude-usage-panel.minimized #minimize-button:hover {
            background: rgba(255, 255, 255, 0.15);
            opacity: 1;
        }

        /* Fetch-state and usage-threshold colour feedback on the ◉ circle when minimized */
        #claude-usage-panel.minimized #minimize-button {
            transition: color 0.3s;
        }
        #claude-usage-panel.minimized #minimize-button.fetch-loading      { color: rgba(150, 150, 150, 0.55); }
        #claude-usage-panel.minimized #minimize-button.fetch-failed        { color: rgba(210, 200, 185, 0.80); }
        #claude-usage-panel.minimized #minimize-button.usage-warn-five-hour { color: rgba(255, 220,  60, 1); }
        #claude-usage-panel.minimized #minimize-button.usage-warn-seven-day { color: rgba(210, 155,  20, 1); }

        /* Slightly brighten border on hover */
        #claude-usage-panel:hover {
            border-color: rgba(255, 255, 255, 0.32);
        }

        /* Individual stat rows — prevent line-wrapping, smooth colour transitions */
        .stat-row {
            white-space: nowrap;
            transition: color 0.3s;
        }

        /* Fetch-state colour classes — applied to .stat-row elements */
        .stat-row.fetch-loading  { color: rgba(150, 150, 150, 0.55); }
        .stat-row.fetch-failed   { color: rgba(210, 200, 185, 0.80); }
        .stat-row.spend-over-limit { color: rgba(255, 175, 100, 1);  }

        /* Usage-threshold colour classes — >75% 5H is yellow, >75% 7D is darker yellow */
        .stat-row.usage-warn-five-hour { color: rgba(255, 220,  60, 1); }
        .stat-row.usage-warn-seven-day { color: rgba(210, 155,  20, 1); }

        /* Shared button style — rounded rect with a slight background inversion */
        .panel-button {
            text-align: center;
            font-size: 17px;
            line-height: 1;
            cursor: pointer;
            padding: 1px 6px;
            border-radius: 7px;
            background: rgba(255, 255, 255, 0.12);
            transition: background 0.2s, opacity 0.2s;
        }

        .panel-button:hover {
            background: rgba(255, 255, 255, 0.26);
        }

        /* Button row — minimize and refresh sit side-by-side at the bottom */
        #button-row {
            display: flex;
            flex-direction: row;
            gap: 8px;
            align-items: center;
            justify-content: center;
            margin-top: 1px;
        }
    `;
        document.head.appendChild(styleElement);

        widget = document.createElement('div');
        widget.id = 'claude-usage-panel';

        fiveHourRow = document.createElement('div');
        fiveHourRow.className = 'stat-row';
        fiveHourRow.textContent = '5H: --';

        sevenDayRow = document.createElement('div');
        sevenDayRow.className = 'stat-row';
        sevenDayRow.textContent = '7D: --';

        monthlySpendRow = document.createElement('div');
        monthlySpendRow.className = 'stat-row';
        monthlySpendRow.textContent = 'M$: --';

        refreshButtonElement = document.createElement('div');
        refreshButtonElement.id = 'refresh-button';
        refreshButtonElement.className = 'panel-button';
        refreshButtonElement.textContent = '\u21bb'; /* ↻ */
        refreshButtonElement.addEventListener('click', (clickEvent) => { clickEvent.stopPropagation(); fetchStats(); });

        minimizeButtonElement = document.createElement('div');
        minimizeButtonElement.id = 'minimize-button';
        minimizeButtonElement.className = 'panel-button';
        minimizeButtonElement.textContent = '\u2212'; /* − minus sign */
        minimizeButtonElement.addEventListener('click', (clickEvent) => { clickEvent.stopPropagation(); toggleMinimized(); });
        /* Middle-click on the minimized circle triggers a refresh */
        minimizeButtonElement.addEventListener('auxclick', (mouseEvent) => {
            if (mouseEvent.button === 1 && isMinimized) {
                mouseEvent.preventDefault();
                mouseEvent.stopPropagation();
                fetchStats();
            }
        });

        buttonRowElement = document.createElement('div');
        buttonRowElement.id = 'button-row';
        buttonRowElement.append(refreshButtonElement, minimizeButtonElement);

        widget.append(fiveHourRow, sevenDayRow, monthlySpendRow, buttonRowElement);
        document.body.appendChild(widget);

        /* Restore saved vertical position, overriding the CSS translateY default */
        const savedVerticalPosition = localStorage.getItem(POSITION_STORAGE_KEY);
        if (savedVerticalPosition) {
            widget.style.transform = 'none';
            widget.style.top = savedVerticalPosition;
        }

        setWidgetPending(true);
        updateTitle();
        setFetchStatus('idle');
        updateMinimizeButtonTitle();
        makeDraggable(widget);
    }

    /**
     * Applies or removes the "pending org" yellow tint via CSS class.
     * @param {boolean} pending
     * @returns {void}
     */
    function setWidgetPending(pending) {
        if (!widget) return;
        widget.classList.toggle('pending-organization', pending);
    }

    /**
     * Toggles the widget between minimized and expanded states.
     * @returns {void}
     */
    function toggleMinimized() {
        if (!widget || !minimizeButtonElement) return;
        isMinimized = !isMinimized;
        widget.classList.toggle('minimized', isMinimized);
        updateMinimizeButtonTitle();
        minimizeButtonElement.textContent = isMinimized
            ? '\u25c9'   /* ◉ — shown when minimized, click to restore */
            : '\u2212';  /* − minus sign — click to minimize */
    }

    /**
     * Updates the widget's tooltip with the last-updated time.
     * @returns {void}
     */
    function updateTitle() {
        if (!widget) return;
        widget.title = lastUpdated
            ? 'Updated ' + lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            : 'Not yet updated';
    }

    /**
     * Rebuilds the minimize button's hover tooltip from current DOM state.
     * Shows all stat values, their reset times, and the last refresh time.
     * @returns {void}
     */
    function updateMinimizeButtonTitle() {
        if (!minimizeButtonElement) return;
        const fiveHourSummary = (fiveHourRow?.textContent ?? '--') +
            (fiveHourRow?.title ? `  (${fiveHourRow.title})` : '');
        const sevenDaySummary = (sevenDayRow?.textContent ?? '--') +
            (sevenDayRow?.title ? `  (${sevenDayRow.title})` : '');
        const monthlySpendSummary = (monthlySpendRow?.textContent ?? '--') +
            (monthlySpendRow?.title ? `  (${monthlySpendRow.title})` : '');
        const lastRefreshLine = lastUpdated
            ? 'Last refresh: ' + formatResetTime(lastUpdated.toISOString())
            : 'Last refresh: never';
        const minimizedTooltip = isMinimized ? '(click to expand (middle-click to refresh))' : '(click to minimize)';
        minimizeButtonElement.title = [
            fiveHourSummary,
            sevenDaySummary,
            monthlySpendSummary,
            lastRefreshLine,
            minimizedTooltip
        ].join('\n');
    }

    /**
     * Updates stat row CSS classes and the refresh button tooltip to reflect fetch status.
     * Row colour classes are mutually exclusive; 'ok' clears all so the caller can
     * re-apply per-row overrides (e.g. spend-over-limit on the monthly row).
     * @param {'idle'|'loading'|'ok'|'failed'} status
     * @returns {void}
     */
    function setFetchStatus(status) {
        /* ── Row colour classes ── */
        [fiveHourRow, sevenDayRow, monthlySpendRow].forEach(row => {
            if (!row) return;
            row.classList.remove('fetch-loading', 'fetch-failed', 'spend-over-limit');
            if (status === 'loading') row.classList.add('fetch-loading');
            if (status === 'failed') row.classList.add('fetch-failed');
            /* usage-warn classes are applied separately in fetchStats; clear them on loading/failed */
            if (status === 'loading' || status === 'failed') {
                row.classList.remove('usage-warn-five-hour', 'usage-warn-seven-day');
            }
        });

        /* ── Minimized circle colour — mirrors row state (no spend-over-limit) ── */
        if (minimizeButtonElement) {
            minimizeButtonElement.classList.remove('fetch-loading', 'fetch-failed');
            if (status === 'loading') minimizeButtonElement.classList.add('fetch-loading');
            if (status === 'failed') minimizeButtonElement.classList.add('fetch-failed');
            if (status === 'loading' || status === 'failed') {
                minimizeButtonElement.classList.remove('usage-warn-five-hour', 'usage-warn-seven-day');
            }
        }

        /* ── Refresh button tooltip ── */
        if (refreshButtonElement) {
            const lastRefreshLine = lastUpdated
                ? 'Last refresh: ' + formatResetTime(lastUpdated.toISOString())
                : 'Last refresh: never';
            const statusLine = {
                idle: 'Status: not yet refreshed',
                loading: 'Status: loading\u2026',
                ok: 'Status: OK',
                failed: 'Status: failed',
            }[status] ?? 'Status: ' + status;
            refreshButtonElement.title = lastRefreshLine + '\n' + statusLine;
        }
    }

    /**
     * Refreshes the text content of the three stat rows.
     * @param {string} fiveHour - Formatted 5-hour utilization.
     * @param {string} sevenDay - Formatted 7-day utilization.
     * @param {string} monthlySpend - Formatted monthly spend.
     * @returns {void}
     */
    function updateStatRows(fiveHour, sevenDay, monthlySpend) {
        if (fiveHourRow) fiveHourRow.textContent = '5H: ' + fiveHour;
        if (sevenDayRow) sevenDayRow.textContent = '7D: ' + sevenDay;
        if (monthlySpendRow) monthlySpendRow.textContent = 'M$: ' + monthlySpend;
    }

    /**
     * Makes an element draggable along the Y-axis only, constrained within the viewport.
     * Persists the final position to localStorage under POSITION_STORAGE_KEY.
     * @param {HTMLElement} draggableElement
     * @returns {void}
     */
    function makeDraggable(draggableElement) {
    /** @type {number} */ let startY = 0;
    /** @type {number} */ let startTop = 0;
    /** @type {boolean} */ let active = false;
    /** @type {boolean} */ let dragMoved = false;

        draggableElement.addEventListener('mousedown', (/** @type {MouseEvent} */ mouseEvent) => {
            if (mouseEvent.button !== 0) return;
            active = true;
            dragMoved = false;
            startY = mouseEvent.clientY;
            startTop = draggableElement.getBoundingClientRect().top;
            draggableElement.style.transform = 'none';
            draggableElement.style.top = startTop + 'px';
            mouseEvent.preventDefault();
        });

        document.addEventListener('mousemove', (/** @type {MouseEvent} */ mouseEvent) => {
            if (!active) return;
            const deltaY = mouseEvent.clientY - startY;
            if (Math.abs(deltaY) > 4) dragMoved = true;
            const clampedTop = Math.max(0, Math.min(window.innerHeight - draggableElement.offsetHeight, startTop + deltaY));
            draggableElement.style.top = clampedTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (active && dragMoved) localStorage.setItem(POSITION_STORAGE_KEY, draggableElement.style.top);
            active = false;
        });

        /* Suppress the click that fires after a drag — capture phase fires before children's listeners */
        draggableElement.addEventListener('click', (clickEvent) => {
            if (dragMoved) {
                clickEvent.stopPropagation();
                dragMoved = false;
            }
        }, true);
    }

    /* ─────────────────────────── fetch ─────────────────────────── */

    /**
     * @typedef {{ utilization: number, resets_at: string }} Period
     * @typedef {{ is_enabled: boolean, monthly_limit: number, used_credits: number, utilization: number|null }} ExtraUsage
     * @typedef {{ five_hour: Period, seven_day: Period, extra_usage: ExtraUsage|null }} UsageData
     */

    /**
     * Fetches current usage stats from the Claude API and updates the widget.
     * @returns {Promise<void>}
     */
    async function fetchStats() {
        if (!organizationId) return;
        setFetchStatus('loading');
        updateMinimizeButtonTitle();
        try {
            const response = await fetch(`https://claude.ai/api/organizations/${organizationId}/usage`, {
                credentials: 'include',
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Accept': '*/*',
                    'Accept-Language': (navigator.languages || []).join(',') || navigator.language || 'en-US',
                    'content-type': 'application/json',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'Priority': 'u=4',
                    'Pragma': 'no-cache',
                    'Cache-Control': 'no-cache'
                },
                referrer: 'https://claude.ai/settings/usage',
                method: 'GET',
                mode: 'cors'
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const usageData = /** @type {UsageData} */ (await response.json());
            console.debug('[claude-ai-usage-widget] usage data:', usageData);
            updateStatRows(
                formatPercent(usageData?.five_hour?.utilization),
                formatPercent(usageData?.seven_day?.utilization),
                formatDollars(usageData?.extra_usage?.used_credits)
            );
            lastUpdated = new Date();
            updateTitle();
            setFetchStatus('ok');   /* clears loading/failed classes on all rows */

            /* Apply usage-threshold colours: >75% 5H → yellow; >75% 7D → darker yellow */
            const fiveHourOver = (usageData?.five_hour?.utilization ?? 0) > 75;
            const sevenDayOver = (usageData?.seven_day?.utilization ?? 0) > 75;
            if (fiveHourRow) fiveHourRow.classList.toggle('usage-warn-five-hour', fiveHourOver);
            if (sevenDayRow) sevenDayRow.classList.toggle('usage-warn-seven-day', sevenDayOver);
            /* Minimized circle shows the most severe active warning */
            if (minimizeButtonElement) {
                minimizeButtonElement.classList.toggle('usage-warn-seven-day', sevenDayOver);
                minimizeButtonElement.classList.toggle('usage-warn-five-hour', fiveHourOver && !sevenDayOver);
            }

            if (fiveHourRow) fiveHourRow.title = `resets: ${formatResetTime(usageData?.five_hour?.resets_at)}`;
            if (sevenDayRow) sevenDayRow.title = `resets: ${formatResetTime(usageData?.seven_day?.resets_at)}`;
            const extraUsage = usageData?.extra_usage;
            if (monthlySpendRow && extraUsage) {
                const formattedSpend = extraUsage.used_credits != null && isFinite(extraUsage.used_credits)
                    ? '$' + (extraUsage.used_credits / 100).toFixed(2) : '--';
                const formattedLimit = extraUsage.monthly_limit != null && isFinite(extraUsage.monthly_limit)
                    ? '$' + (extraUsage.monthly_limit / 100).toFixed(2) : '--';
                monthlySpendRow.title = formattedSpend + ' / ' + formattedLimit;
                monthlySpendRow.classList.toggle(
                    'spend-over-limit',
                    extraUsage.is_enabled && extraUsage.used_credits >= extraUsage.monthly_limit
                );
            }
            updateMinimizeButtonTitle();   /* refresh with all data now populated */
        } catch (fetchError) {
            console.warn('[claude-ai-usage-widget] fetch failed:', fetchError);
            setFetchStatus('failed');
            updateMinimizeButtonTitle();
        }
    }

    /* ─────────────────────────── init ─────────────────────────── */

    /**
     * Starts org-ID polling via a debounced MutationObserver and sets up recurring
     * stats refresh once the org ID is found.
     * @returns {void}
     */
    function startObserver() {
        /** @type {ReturnType<typeof setTimeout>|null} */
        let debounceTimer = null;

        const observer = new MutationObserver((mutations) => {
            if (mutations.some((mutation) => mutation.addedNodes.length > 0)) hideWarning();

            if (!organizationId) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const foundOrganizationId = findOrganizationId();
                    if (!foundOrganizationId) return;
                    organizationId = foundOrganizationId;
                    setWidgetPending(false);
                    if (!pollingStarted) {
                        pollingStarted = true;
                        fetchStats();
                        setInterval(fetchStats, REFRESH_INTERVAL_MS);
                    }
                }, DEBOUNCE_DELAY_MS);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Entry point: creates the widget, hides any existing warning, and starts observing.
     * @returns {void}
     */
    function init() {
        console.log('Claude AI Usage Widget');
        createWidget();
        hideWarning();

        const foundOrganizationId = findOrganizationId();
        if (foundOrganizationId) {
            organizationId = foundOrganizationId;
            setWidgetPending(false);
            pollingStarted = true;
            fetchStats();
            setInterval(fetchStats, REFRESH_INTERVAL_MS);
        }

        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();