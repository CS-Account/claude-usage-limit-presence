// ==UserScript==
// @name         Claude AI Usage Widget
// @namespace    claude-ai-usage-widget
// @version      0.2.0
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
     * @type {string}
     */
    const WARNING_XPATH =
        "//span[contains(., '% of your') and contains(., 'limit')]" +
        "/ancestor::div[contains(@class,'px-3') and contains(@class,'md:px-2')]";

    /** Auto-refresh interval (2 min). @type {number} */
    const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

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

    /* --- Widget element refs --- */
    /** @type {HTMLElement|null} */ let widget = null;
    /** @type {HTMLElement|null} */ let fiveHourSectionEl = null;
    /** @type {HTMLElement|null} */ let fiveHourValueEl = null;
    /** @type {HTMLElement|null} */ let fiveHourCountdownEl = null;
    /** @type {HTMLElement|null} */ let sevenDaySectionEl = null;
    /** @type {HTMLElement|null} */ let sevenDayValueEl = null;
    /** @type {HTMLElement|null} */ let sevenDayCountdownEl = null;
    /** @type {HTMLElement|null} */ let monthlySectionEl = null;
    /** @type {HTMLElement|null} */ let monthlyValueEl = null;
    /** @type {HTMLElement|null} */ let refreshButtonElement = null;

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
     * @param {number|null|undefined} utilization
     * @returns {string} e.g. "42%" or "--"
     */
    const formatPercent = (utilization) =>
        utilization != null && isFinite(/** @type {number} */(utilization))
            ? Math.round(/** @type {number} */(utilization)) + '%'
            : '--';

    /**
     * Formats a credit value (cents) as a dollar amount string.
     * @param {number|null|undefined} cents
     * @returns {string} e.g. "3.50" or "--"
     */
    const formatDollars = (cents) =>
        cents != null && isFinite(/** @type {number} */(cents))
            ? (/** @type {number} */ (cents) / 100).toFixed(2)
            : '--';

    /**
     * Formats a reset timestamp in local time as "YYYY-MM-DD HH:MM:SS ±HHMM".
     * @param {string|null|undefined} isoTimestamp
     * @returns {string}
     */
    function formatResetTime(isoTimestamp) {
        if (!isoTimestamp) return '--';
        const date = new Date(isoTimestamp);
        if (isNaN(date.getTime())) return '--';
        const zeroPad = (/** @type {number} */ n) => String(n).padStart(2, '0');
        const offsetMinutes = -date.getTimezoneOffset();
        const offsetSign = offsetMinutes >= 0 ? '+' : '-';
        const absOffset = Math.abs(offsetMinutes);
        return date.getFullYear() + '-' + zeroPad(date.getMonth() + 1) + '-' + zeroPad(date.getDate()) + ' ' +
            zeroPad(date.getHours()) + ':' + zeroPad(date.getMinutes()) + ':' + zeroPad(date.getSeconds()) + ' ' +
            offsetSign + zeroPad(Math.floor(absOffset / 60)) + zeroPad(absOffset % 60);
    }

    /**
     * Returns how far through the current reset period we are, e.g. "62% through".
     * @param {string|null|undefined} isoTimestamp - The period's resets_at timestamp.
     * @param {number} periodMs - Total period duration in milliseconds.
     * @returns {string}
     */
    function periodElapsed(isoTimestamp, periodMs) {
        if (!isoTimestamp) return '--';
        const resetDate = new Date(isoTimestamp);
        if (isNaN(resetDate.getTime())) return '--';
        const elapsed = Date.now() - (resetDate.getTime() - periodMs);
        return Math.round(Math.max(0, Math.min(100, (elapsed / periodMs) * 100))) + '% through';
    }

    /**
     * Returns a compact human-readable countdown to a reset timestamp (e.g. "5h12m", "2d6h").
     * @param {string|null|undefined} isoTimestamp
     * @returns {string}
     */
    function formatTimeUntilReset(isoTimestamp) {
        if (!isoTimestamp) return '--';
        const resetDate = new Date(isoTimestamp);
        if (isNaN(resetDate.getTime())) return '--';
        const diffMs = resetDate.getTime() - Date.now();
        if (diffMs <= 0) return '0m';
        const totalMinutes = Math.floor(diffMs / 60000);
        const days = Math.floor(totalMinutes / (60 * 24));
        const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
        const minutes = totalMinutes % 60;
        if (days > 0) return `${days}d${hours}h`;
        if (hours > 0) return `${hours}h${minutes}m`;
        return `${minutes}m`;
    }

    /* ─────────────────────────── widget ─────────────────────────── */

    /**
     * Builds a period section element (label + value + optional countdown).
     * @param {string} labelText
     * @param {boolean} withCountdown
     * @returns {{ section: HTMLElement, value: HTMLElement, countdown: HTMLElement|null }}
     */
    function makePeriodSection(labelText, withCountdown) {
        const section = document.createElement('div');
        section.className = 'period-section';

        const label = document.createElement('div');
        label.className = 'period-label';
        label.textContent = labelText;

        const divider = document.createElement('div');
        divider.className = 'period-divider';

        const value = document.createElement('div');
        value.className = 'period-value';
        value.textContent = '--';

        section.append(label, divider, value);

        let countdown = null;
        if (withCountdown) {
            countdown = document.createElement('div');
            countdown.className = 'period-countdown';
            countdown.textContent = '--';
            section.appendChild(countdown);
        }

        return { section, value, countdown };
    }

    /**
     * Injects CSS and builds the widget DOM, then attaches it to body.
     * @returns {void}
     */
    function createWidget() {
        const styleElement = document.createElement('style');
        styleElement.textContent = `
        #claude-usage-panel {
            --clr-bg:           rgba(20, 20, 20, 0.62);
            --clr-pending-bg:   rgba(180, 140, 0, 0.6);
            --clr-border:       rgba(255, 255, 255, 0.15);
            --clr-border-hover: rgba(255, 255, 255, 0.32);
            --clr-text:         rgba(255, 255, 255, 0.85);
            --clr-label:        rgba(255, 255, 255, 0.75);
            --clr-countdown:    rgba(209, 230, 255, 0.85);
            --clr-sep-section:  rgba(255, 255, 255, 0.85);
            --clr-sep-divider:  rgba(255, 255, 255, 0.42);
            --clr-btn-bg:       rgba(255, 255, 255, 0.12);
            --clr-btn-hover:    rgba(255, 255, 255, 0.26);
            --clr-loading:      rgba(150, 150, 150, 0.55);
            --clr-failed:       rgba(210, 200, 185, 0.80);
            --clr-warn-5h:      rgba(255, 220,  60, 1);
            --clr-warn-7d:      rgba(210, 155,  20, 1);
            --clr-spend-over:   rgba(255, 175, 100, 1);

            position: fixed;
            right: 6px;
            top: 75%;
            transform: translateY(-50%);
            z-index: 9999;

            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 5px;
            padding: 6px 6px;
            border-radius: 16px;

            background: var(--clr-bg);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            border: 1px solid var(--clr-border);

            color: var(--clr-text);
            font: 600 15px / 1.4 monospace;

            user-select: none;
            cursor: default;
            transition: background 0.3s;
        }

        #claude-usage-panel.pending-organization {
            background: var(--clr-pending-bg);
        }

        #claude-usage-panel:hover {
            border-color: var(--clr-border-hover);
        }

        .period-section {
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            line-height: 1.15;
        }

        .period-label {
            font-size: 14px;
            font-weight: bold;
            color: var(--clr-label);
            padding-bottom: 2px;
        }

        /* Thin transparent line between label and values */
        .period-divider {
            align-self: stretch;
            height: 1px;
            background: var(--clr-sep-divider);
            margin-bottom: 2px;
        }

        /* Thicker opaque line between sections */
        .section-separator {
            align-self: stretch;
            height: 3px;
            background: var(--clr-sep-section);
        }

        .period-value {
            transition: color 0.3s;
            font-weight: normal;
        }

        .period-countdown {
            font-size: 14px;
            font-weight: normal;
            color: var(--clr-countdown);
            line-height: 1.2;
        }

        .period-value.fetch-loading        { color: var(--clr-loading);    }
        .period-value.fetch-failed         { color: var(--clr-failed);     }
        .period-value.spend-over-limit     { color: var(--clr-spend-over); }
        .period-value.usage-warn-five-hour { color: var(--clr-warn-5h);   }
        .period-value.usage-warn-seven-day { color: var(--clr-warn-7d);   }

        .panel-button {
            text-align: center;
            font-size: 17px;
            line-height: 1;
            cursor: pointer;
            padding: 1px 6px;
            border-radius: 7px;
            background: var(--clr-btn-bg);
            transition: background 0.2s;
        }

        .panel-button:hover {
            background: var(--clr-btn-hover);
        }
    `;
        document.head.appendChild(styleElement);

        widget = document.createElement('div');
        widget.id = 'claude-usage-panel';

        ({ section: fiveHourSectionEl, value: fiveHourValueEl, countdown: fiveHourCountdownEl } =
            makePeriodSection('5h', true));

        ({ section: sevenDaySectionEl, value: sevenDayValueEl, countdown: sevenDayCountdownEl } =
            makePeriodSection('7d', true));

        ({ section: monthlySectionEl, value: monthlyValueEl } =
            makePeriodSection('MS', false));

        refreshButtonElement = document.createElement('div');
        refreshButtonElement.id = 'refresh-button';
        refreshButtonElement.className = 'panel-button';
        refreshButtonElement.textContent = '\u21bb'; /* ↻ */
        refreshButtonElement.addEventListener('click', (e) => { e.stopPropagation(); fetchStats(); });

        const makeSep = () => { const d = document.createElement('div'); d.className = 'section-separator'; return d; };
        widget.append(fiveHourSectionEl, makeSep(), sevenDaySectionEl, makeSep(), monthlySectionEl, refreshButtonElement);
        document.body.appendChild(widget);

        /* Restore saved vertical position */
        const savedVerticalPosition = localStorage.getItem(POSITION_STORAGE_KEY);
        if (savedVerticalPosition) {
            widget.style.transform = 'none';
            widget.style.top = savedVerticalPosition;
        }

        setWidgetPending(true);
        setFetchStatus('idle');
        makeDraggable(widget);
    }

    /**
     * Applies or removes the "pending org" yellow tint.
     * @param {boolean} pending
     * @returns {void}
     */
    function setWidgetPending(pending) {
        if (!widget) return;
        widget.classList.toggle('pending-organization', pending);
    }

    /**
     * Updates value element CSS classes and the refresh button tooltip to reflect fetch status.
     * @param {'idle'|'loading'|'ok'|'failed'} status
     * @returns {void}
     */
    function setFetchStatus(status) {
        [fiveHourValueEl, sevenDayValueEl, monthlyValueEl].forEach(el => {
            if (!el) return;
            el.classList.remove('fetch-loading', 'fetch-failed');
            if (status === 'loading') el.classList.add('fetch-loading');
            if (status === 'failed')  el.classList.add('fetch-failed');
            if (status === 'loading' || status === 'failed') {
                el.classList.remove('usage-warn-five-hour', 'usage-warn-seven-day');
            }
        });

        if (refreshButtonElement) {
            const lastRefreshLine = lastUpdated
                ? 'Last refresh: ' + formatResetTime(lastUpdated.toISOString())
                : 'Last refresh: never';
            const statusLine = {
                idle:    'Status: not yet refreshed',
                loading: 'Status: loading\u2026',
                ok:      'Status: OK',
                failed:  'Status: failed',
            }[status] ?? 'Status: ' + status;
            refreshButtonElement.title = lastRefreshLine + '\n' + statusLine;
        }
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

        draggableElement.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
            if (e.button !== 0) return;
            active = true;
            dragMoved = false;
            startY = e.clientY;
            startTop = draggableElement.getBoundingClientRect().top;
            draggableElement.style.transform = 'none';
            draggableElement.style.top = startTop + 'px';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (/** @type {MouseEvent} */ e) => {
            if (!active) return;
            const deltaY = e.clientY - startY;
            if (Math.abs(deltaY) > 4) dragMoved = true;
            const clampedTop = Math.max(0, Math.min(window.innerHeight - draggableElement.offsetHeight, startTop + deltaY));
            draggableElement.style.top = clampedTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (active && dragMoved) localStorage.setItem(POSITION_STORAGE_KEY, draggableElement.style.top);
            active = false;
        });

        /* Suppress the click that fires after a drag */
        draggableElement.addEventListener('click', (e) => {
            if (dragMoved) { e.stopPropagation(); dragMoved = false; }
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
            const data = /** @type {UsageData} */ (await response.json());
            console.debug('[claude-ai-usage-widget] usage data:', data);

            const fiveHourPct       = formatPercent(data?.five_hour?.utilization);
            const sevenDayPct       = formatPercent(data?.seven_day?.utilization);
            const fiveHourCountdown = formatTimeUntilReset(data?.five_hour?.resets_at);
            const sevenDayCountdown = formatTimeUntilReset(data?.seven_day?.resets_at);
            const fiveHourResetFull = formatResetTime(data?.five_hour?.resets_at);
            const sevenDayResetFull = formatResetTime(data?.seven_day?.resets_at);

            if (fiveHourValueEl)     fiveHourValueEl.textContent     = fiveHourPct;
            if (fiveHourCountdownEl) fiveHourCountdownEl.textContent = fiveHourCountdown;
            if (sevenDayValueEl)     sevenDayValueEl.textContent     = sevenDayPct;
            if (sevenDayCountdownEl) sevenDayCountdownEl.textContent = sevenDayCountdown;

            const extra = data?.extra_usage;
            if (monthlyValueEl) monthlyValueEl.textContent = formatDollars(extra?.used_credits);

            lastUpdated = new Date();
            setFetchStatus('ok');

            /* Usage-threshold colours */
            const fiveHourOver = (data?.five_hour?.utilization ?? 0) > 75;
            const sevenDayOver = (data?.seven_day?.utilization ?? 0) > 75;
            if (fiveHourValueEl) fiveHourValueEl.classList.toggle('usage-warn-five-hour', fiveHourOver);
            if (sevenDayValueEl) sevenDayValueEl.classList.toggle('usage-warn-seven-day', sevenDayOver);

            /* Monthly spend-over-limit colour */
            if (monthlyValueEl && extra) {
                monthlyValueEl.classList.toggle(
                    'spend-over-limit',
                    extra.is_enabled && extra.used_credits >= extra.monthly_limit
                );
            }

            /* Section tooltips */
            const FH_MS = 5 * 60 * 60 * 1000;
            const SD_MS = 7 * 24 * 60 * 60 * 1000;

            if (fiveHourSectionEl) {
                fiveHourSectionEl.title = [
                    'usage:     ' + fiveHourPct,
                    'resets in: ' + fiveHourCountdown,
                    'resets at: ' + fiveHourResetFull,
                    'elapsed:   ' + periodElapsed(data?.five_hour?.resets_at, FH_MS),
                ].join('\n');
            }
            if (sevenDaySectionEl) {
                const sevenDayDate = data?.seven_day?.resets_at ? new Date(data.seven_day.resets_at) : null;
                const sevenDayOfWeek = (sevenDayDate && !isNaN(sevenDayDate.getTime()))
                    ? sevenDayDate.toLocaleDateString([], { weekday: 'long' }) : '';
                sevenDaySectionEl.title = [
                    'usage:     ' + sevenDayPct,
                    'resets in: ' + sevenDayCountdown,
                    'resets at: ' + [sevenDayResetFull, sevenDayOfWeek].filter(Boolean).join(' '),
                    'elapsed:   ' + periodElapsed(data?.seven_day?.resets_at, SD_MS),
                ].join('\n');
            }
            if (monthlySectionEl && extra) {
                const spendStr = extra.used_credits != null && isFinite(extra.used_credits)
                    ? '$' + (extra.used_credits / 100).toFixed(2) : '--';
                const limitStr = extra.monthly_limit != null && isFinite(extra.monthly_limit)
                    ? '$' + (extra.monthly_limit / 100).toFixed(2) : '--';
                monthlySectionEl.title = spendStr + ' / ' + limitStr;
            }

        } catch (fetchError) {
            console.warn('[claude-ai-usage-widget] fetch failed:', fetchError);
            setFetchStatus('failed');
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
            if (mutations.some((m) => m.addedNodes.length > 0)) hideWarning();

            if (!organizationId) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const foundId = findOrganizationId();
                    if (!foundId) return;
                    organizationId = foundId;
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

        const foundId = findOrganizationId();
        if (foundId) {
            organizationId = foundId;
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
