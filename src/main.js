// ==UserScript==
// @name         Claude AI Usage Widget
// @namespace    claude-ai-usage-widget
// @version      0.3.0
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

    /** localStorage key for persisting widget state (position + mode). @type {string} */
    const STATE_STORAGE_KEY = 'claude-usage-panel-state';

    /** CSS class names for the two themes. @type {string} */
    const DARK_CLASS  = 'theme-dark';
    const LIGHT_CLASS = 'theme-light';

    /** SVG icons for the mode-toggle button. Use --clr-icon-* vars so both themes work. */
    /* shown in vertical mode   → click switches to horizontal (landscape rect = ghost/origin) */
    const SVG_ARROWS_H = '<svg width="32" height="32" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="14" y="14" width="22" height="10" rx="2.5" fill="none" stroke="var(--clr-icon-origin)" stroke-width="3"/><rect x="40" y="28" width="10" height="22" rx="2.5" fill="none" stroke="var(--clr-icon-ghost)" stroke-width="3"/><circle cx="45" cy="19" r="22.2" fill="none" stroke="var(--clr-icon-arc)" stroke-width="3" stroke-linecap="round" stroke-dasharray="11.624 127.865" stroke-dashoffset="-46.496"/><circle cx="45" cy="19" r="1.5" fill="var(--clr-icon-arc)"/></svg>';
    /* shown in horizontal mode → click switches to vertical   (portrait   rect = ghost/origin) */
    const SVG_ARROWS_V = '<svg width="32" height="32" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="14" y="14" width="22" height="10" rx="2.5" fill="none" stroke="var(--clr-icon-ghost)" stroke-width="3"/><rect x="40" y="28" width="10" height="22" rx="2.5" fill="none" stroke="var(--clr-icon-origin)" stroke-width="3"/><circle cx="45" cy="19" r="22.2" fill="none" stroke="var(--clr-icon-arc)" stroke-width="3" stroke-linecap="round" stroke-dasharray="11.624 127.865" stroke-dashoffset="-46.496"/><circle cx="45" cy="19" r="1.5" fill="var(--clr-icon-arc)"/></svg>';

    /** @type {string|null} */
    let organizationId = null;

    /** @type {Date|null} */
    let lastUpdated = null;

    /** @type {boolean} */
    let pollingStarted = false;

    /**
     * Persisted widget state.
     * @type {{ verticalPositionPx: number|null, horizontalPositionPx: number|null, mode: string }}
     */
    let state = {
        verticalPositionPx: null,
        horizontalPositionPx: null,
        mode: 'vertical',
    };

    /** @type {string} */
    let currentMode = 'vertical';

    /* --- Widget element refs --- */
    /** @type {HTMLElement|null} */ let widget = null;
    /** @type {HTMLElement|null} */ let panelElement = null;
    /** @type {HTMLElement|null} */ let fiveHourSectionElement = null;
    /** @type {HTMLElement|null} */ let fiveHourValueElement = null;
    /** @type {HTMLElement|null} */ let fiveHourCountdownElement = null;
    /** @type {HTMLElement|null} */ let sevenDaySectionElement = null;
    /** @type {HTMLElement|null} */ let sevenDayValueElement = null;
    /** @type {HTMLElement|null} */ let sevenDayCountdownElement = null;
    /** @type {HTMLElement|null} */ let monthlySectionElement = null;
    /** @type {HTMLElement|null} */ let monthlyLabelElement = null;
    /** @type {HTMLElement|null} */ let monthlyValueElement = null;
    /** @type {HTMLElement|null} */ let monthlyUtilElement = null;
    /** @type {HTMLElement|null} */ let refreshButtonElement = null;
    /** @type {HTMLElement|null} */ let modeButtonElement = null;

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
        return document.cookie.split('; ')
            .find(cookie => cookie.startsWith('lastActiveOrg='))
            ?.split('=')[1] ?? null;
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
        const datePart = date.getFullYear() + '-'
            + zeroPad(date.getMonth() + 1) + '-'
            + zeroPad(date.getDate());
        const timePart = zeroPad(date.getHours()) + ':'
            + zeroPad(date.getMinutes()) + ':'
            + zeroPad(date.getSeconds());
        const tzPart = offsetSign
            + zeroPad(Math.floor(absOffset / 60))
            + zeroPad(absOffset % 60);
        return datePart + ' ' + timePart + ' ' + tzPart;
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
        return Math.round(
            Math.max(0, Math.min(100, (elapsed / periodMs) * 100))
        ) + '% through';
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

    /**
     * Computes an HSL colour for the monthly spend value, interpolating from green (0%) to orange (100%).
     * Returns red when the limit is exceeded. Accounts for the active theme.
     * @param {number} utilization - 0–100
     * @param {boolean} [exceeded] - true when the spend limit has been exceeded
     * @returns {string} CSS colour string
     */
    function monthlySpendColor(utilization, exceeded = false) {
        if (exceeded) {
            return 'var(--clr-exceeded)';
        }
        const isLight = document.documentElement.getAttribute('data-mode') === 'light';
        const t = Math.max(0, Math.min(1, utilization / 100));
        const h = Math.round(145 + (28 - 145) * t); /* green(145) → orange(28) */
        if (isLight) {
            const s = Math.round(40 + (75 - 40) * t);
            const l = Math.round(36 + (43 - 36) * t);
            return `hsl(${h}, ${s}%, ${l}%)`;
        }
        const s = Math.round(50 + (90 - 50) * t);
        const l = Math.round(42 + (65 - 42) * t);
        return `hsl(${h}, ${s}%, ${l}%)`;
    }

    /**
     * Loads widget state from localStorage, with defaults.
     * @returns {{ verticalPositionPx: number|null, horizontalPositionPx: number|null, mode: string }}
     */
    function loadState() {
        try {
            const raw = localStorage.getItem(STATE_STORAGE_KEY);
            if (raw) return Object.assign(
                { verticalPositionPx: null, horizontalPositionPx: null, mode: 'vertical' },
                JSON.parse(raw)
            );
        } catch {}
        return { verticalPositionPx: null, horizontalPositionPx: null, mode: 'vertical' };
    }

    /**
     * Persists the current state object to localStorage.
     * @returns {void}
     */
    function saveState() {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
    }

    /* ─────────────────────────── widget ─────────────────────────── */

    /**
     * Builds a period section element (label + value + optional countdown).
     * @param {string} labelText
     * @param {boolean} withCountdown
     * @returns {{ section: HTMLElement, label: HTMLElement, value: HTMLElement, countdown: HTMLElement|null }}
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
        value.className = 'period-primary';
        value.textContent = '--';

        section.append(label, divider, value);

        const countdown = document.createElement('div');
        countdown.className = withCountdown
            ? 'period-secondary'
            : 'period-secondary period-secondary--spacer';
        countdown.textContent = withCountdown ? '--' : '\u00a0'; /* nbsp holds line height */
        section.appendChild(countdown);

        return { section, label, value, countdown: withCountdown ? countdown : null };
    }

    /**
     * Clamps the widget so it stays fully within the current viewport.
     * In vertical mode clamps top; in horizontal mode clamps left.
     * Only applies when the widget has an explicit pixel position (i.e. after drag or restore).
     * @returns {void}
     */
    function clampWidgetPosition() {
        if (!widget) return;
        if (currentMode === 'horizontal') {
            if (!widget.style.left || widget.style.left.endsWith('%')) return;
            const currentLeft = parseFloat(widget.style.left);
            if (isNaN(currentLeft)) return;
            const maxLeft = window.innerWidth - widget.offsetWidth;
            const clamped = Math.max(0, Math.min(maxLeft, currentLeft));
            if (clamped !== currentLeft) {
                widget.style.left = clamped + 'px';
                state.horizontalPositionPx = clamped;
                saveState();
            }
        } else {
            if (!widget.style.top || widget.style.top.endsWith('%')) return;
            const currentTop = parseFloat(widget.style.top);
            if (isNaN(currentTop)) return;
            const maxTop = window.innerHeight - widget.offsetHeight;
            const clamped = Math.max(0, Math.min(maxTop, currentTop));
            if (clamped !== currentTop) {
                widget.style.top = clamped + 'px';
                state.verticalPositionPx = clamped;
                saveState();
            }
        }
    }

    /**
     * Applies a layout mode ('vertical' or 'horizontal'), repositioning the widget
     * and updating the mode button icon.
     * @param {string} newMode
     * @returns {void}
     */
    function applyMode(newMode) {
        if (!widget) return;
        currentMode = newMode;
        state.mode = newMode;
        widget.classList.toggle('mode-horizontal', newMode === 'horizontal');

        if (newMode === 'horizontal') {
            widget.style.right = 'auto';
            widget.style.top = '6px';
            if (state.horizontalPositionPx != null) {
                widget.style.left = state.horizontalPositionPx + 'px';
                widget.style.transform = 'none';
            } else {
                widget.style.left = '50%';
                widget.style.transform = 'translateX(-50%)';
            }
            if (modeButtonElement) modeButtonElement.innerHTML = SVG_ARROWS_V;
        } else {
            widget.style.left = 'auto';
            widget.style.right = '6px';
            if (state.verticalPositionPx != null) {
                widget.style.top = state.verticalPositionPx + 'px';
                widget.style.transform = 'none';
            } else {
                widget.style.top = '75%';
                widget.style.transform = 'translateY(-50%)';
            }
            if (modeButtonElement) modeButtonElement.innerHTML = SVG_ARROWS_H;
        }

        saveState();
        clampWidgetPosition();
    }

    /**
     * Toggles between 'vertical' and 'horizontal' modes.
     * @returns {void}
     */
    function toggleMode() {
        applyMode(currentMode === 'horizontal' ? 'vertical' : 'horizontal');
    }

    /**
     * Injects CSS and builds the widget DOM, then attaches it to body.
     * @returns {void}
     */
    function createWidget() {
        widget = document.createElement('div');
        widget.id = 'claude-usage-panel';
        const shadow = widget.attachShadow({ mode: 'open' });

        const styleElement = document.createElement('style');
        styleElement.textContent = `
        /* ── Variables + host layout (dark theme is default) ── */
        :host {
            --sep-thickness: 2px;
            --item-gap:      4px;
            --font-sm:       14px;
            --font-md:       15px;
            --font-lg:       17px;
            --divider-gap:   2px;

            --clr-bg:           rgba(20, 20, 20, 0.75);
            --clr-bg-pending:   rgba(180, 140, 0, 0.6);
            --clr-border:       rgba(255, 255, 255, 0.15);
            --clr-border-hover: rgba(255, 255, 255, 0.75);
            --clr-text:         rgba(255, 255, 255, 0.85);
            --clr-text-muted:        rgba(255, 255, 255, 0.75);
            --clr-text-countdown:    rgba(209, 230, 255, 0.85);
            --clr-sep-section:  rgba(255, 255, 255, 0.85);
            --clr-sep-divider:  rgba(255, 255, 255, 0.42);
            --clr-bg-btn:       rgba(255, 255, 255, 0.12);
            --clr-bg-btn-hover:    rgba(255, 255, 255, 0.25);
            --clr-text-loading:      rgba(150, 150, 150, 0.55);
            --clr-text-failed:       rgba(210, 200, 185, 0.80);
            --clr-state-warn-5h:      rgba(255, 220,  60, 1);
            --clr-state-warn-7d:      rgba(210, 155,  20, 1);
            --clr-state-disabled: rgba(150, 150, 150, 0.55);
            --clr-exceeded: rgba(211, 95, 95, 0.92);
            --clr-icon-origin:        rgba(255, 255, 255, 0.85);
            --clr-icon-ghost:         rgba(136, 136, 136, 0.75);
            --clr-icon-arc:          rgba(200, 200, 200, 0.80);

            position: fixed;
            right: 6px;
            top: 75%;
            transform: translateY(-50%);
            z-index: 9999;
        }

        .container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--item-gap);
            padding: 6px;
            border-radius: 16px;

            background: var(--clr-bg);
            backdrop-filter: blur(2px);
            -webkit-backdrop-filter: blur(2px);
            border: 1px solid var(--clr-border);

            color: var(--clr-text);
            font-family: monospace;
            font-size: var(--font-md);
            font-weight: normal;
            line-height: 1.4;

            user-select: none;
            cursor: default;
            transition:
                background 0.2s,
                border-color 0.2s,
                backdrop-filter 0.2s,
                -webkit-backdrop-filter 0.2s;
        }

        /* ── Light theme overrides ── */
        :host(.theme-light) {
            --clr-bg:           rgba(225, 222, 210, 0.75);
            --clr-bg-pending:   rgba(160, 120, 0, 0.5);
            --clr-border:       rgba(0, 0, 0, 0.15);
            --clr-border-hover: rgba(0, 0, 0, 0.75);
            --clr-text:         rgba(20, 20, 20, 0.90);
            --clr-text-muted:        rgba(20, 20, 20, 0.70);
            --clr-text-countdown:    rgba(30, 80, 160, 0.85);
            --clr-sep-section:  rgba(20, 20, 20, 0.65);
            --clr-sep-divider:  rgba(20, 20, 20, 0.25);
            --clr-bg-btn:       rgba(0, 0, 0, 0.08);
            --clr-bg-btn-hover:    rgba(0, 0, 0, 0.25);
            --clr-text-loading:      rgba(100, 100, 100, 0.60);
            --clr-text-failed:       rgba(90, 80, 65, 0.80);
            --clr-state-warn-5h:      rgba(180, 135, 0, 1);
            --clr-state-warn-7d:      rgba(155, 100, 0, 1);
            --clr-state-disabled: rgba(110, 110, 110, 0.65);
            --clr-exceeded: rgba(170, 63, 63, 0.88);
            --clr-icon-origin:        rgba( 20,  20,  20, 0.90);
            --clr-icon-ghost:         rgba(140, 140, 140, 0.75);
            --clr-icon-arc:          rgba( 80,  80,  80, 0.75);
        }

        /* ── Horizontal mode ── */
        :host(.mode-horizontal) {
            right: auto;
            top: 6px;
            transform: none;
        }

        :host(.mode-horizontal) .container {
            flex-direction: row;
            align-items: stretch;
        }

        :host(.mode-horizontal) .section-separator {
            width: var(--sep-thickness);
            height: auto;
            align-self: stretch;
        }

        /* Each section becomes a 2-row grid: label | divider | primary / secondary */
        :host(.mode-horizontal) .period-section {
            display: grid;
            grid-template-columns: auto 1px auto;
            grid-template-rows: auto auto;
            column-gap: var(--divider-gap);
            padding: 0 2px;
        }

        :host(.mode-horizontal) .period-label {
            grid-column: 1;
            grid-row: 1 / 3;
            align-self: center;
            padding-bottom: 0;
        }

        :host(.mode-horizontal) .period-divider {
            grid-column: 2;
            grid-row: 1 / 3;
            width: 1px;
            height: auto;
            align-self: stretch;
            margin-bottom: 0;
        }

        :host(.mode-horizontal) .period-primary   {
            grid-column: 3; grid-row: 1; align-self: end;
        }
        :host(.mode-horizontal) .period-secondary {
            grid-column: 3; grid-row: 2; align-self: start;
        }

        /* Buttons group — column in vertical mode, row in horizontal */
        .buttons-group {
            display: flex;
            flex-direction: column;
            gap: var(--item-gap);
            align-items: center;
            justify-content: center;
        }

        :host(.mode-horizontal) .buttons-group {
            flex-direction: row; align-self: center;
        }

        :host(.pending-organization) .container {
            background: var(--clr-bg-pending);
        }
        :host(:hover) .container {
            border-color: var(--clr-border-hover);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
        }

        /* ── Section layout ── */
        .period-section {
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            line-height: 1.15;
        }

        .period-label {
            font-size: var(--font-sm);
            font-weight: bold;
            color: var(--clr-text-muted);
            padding-bottom: var(--divider-gap);
        }

        .period-divider {
            align-self: stretch;
            height: 1px;
            background: var(--clr-sep-divider);
            margin-bottom: var(--divider-gap);
        }

        .section-separator {
            align-self: stretch;
            height: var(--sep-thickness);
            background: var(--clr-sep-section);
        }

        /* ── Data rows ── */
        .period-primary   { font-weight: normal; transition: color 0.2s; }

        .period-secondary {
            font-size: var(--font-sm);
            font-weight: normal;
            color: var(--clr-text);
            line-height: 1.2;
            transition: color 0.2s;
        }

        /* Countdown sections use a distinct tint */
        .period-secondary.countdown { color: var(--clr-text-countdown); }

        /* Monthly section disabled/exceeded states */
        .period-label.label-disabled { color: var(--clr-state-disabled); }
        .period-label.label-exceeded { color: var(--clr-exceeded); }
.period-secondary--spacer { display: none; }
        :host(.mode-horizontal) .period-secondary--spacer {
            display: block; visibility: hidden;
        }

        /* ── State modifiers — apply to primary and/or secondary ── */
        .period-primary.is-loading,
        .period-secondary.is-loading { color: var(--clr-text-loading);  }
        .period-primary.is-failed,
        .period-secondary.is-failed  { color: var(--clr-text-failed);   }
        .period-primary.warn-5h      { color: var(--clr-state-warn-5h);  }
        .period-primary.warn-7d      { color: var(--clr-state-warn-7d);  }

        /* ── Buttons ── */
        .panel-button {
            box-sizing: border-box;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: monospace;
            font-size: var(--font-lg);
            cursor: pointer;
            border-radius: 7px;
            background: var(--clr-bg-btn);
            transition: background 0.2s;
        }

        .panel-button svg { display: block; }

        .panel-button:hover { background: var(--clr-bg-btn-hover); }
    `;
        shadow.appendChild(styleElement);

        ({
            section: fiveHourSectionElement,
            value: fiveHourValueElement,
            countdown: fiveHourCountdownElement,
        } = makePeriodSection('5h', true));
        if (fiveHourCountdownElement) fiveHourCountdownElement.classList.add('countdown');

        ({
            section: sevenDaySectionElement,
            value: sevenDayValueElement,
            countdown: sevenDayCountdownElement,
        } = makePeriodSection('7d', true));
        if (sevenDayCountdownElement) sevenDayCountdownElement.classList.add('countdown');

        ({
            section: monthlySectionElement,
            label: monthlyLabelElement,
            value: monthlyValueElement,
            countdown: monthlyUtilElement,
        } = makePeriodSection('MS', true));
        if (monthlyUtilElement) monthlyUtilElement.classList.add('countdown');

        modeButtonElement = document.createElement('div');
        modeButtonElement.id = 'mode-button';
        modeButtonElement.className = 'panel-button';
        modeButtonElement.title = 'Switch layout mode';
        modeButtonElement.addEventListener('click', (event) => {
            event.stopPropagation(); toggleMode();
        });

        refreshButtonElement = document.createElement('div');
        refreshButtonElement.id = 'refresh-button';
        refreshButtonElement.className = 'panel-button';
        refreshButtonElement.textContent = '\u21bb'; /* ↻ */
        refreshButtonElement.addEventListener('click', (event) => {
            event.stopPropagation(); fetchStats();
        });

        const buttonsGroup = document.createElement('div');
        buttonsGroup.className = 'buttons-group';
        buttonsGroup.append(modeButtonElement, refreshButtonElement);

        const makeSep = () => {
            const d = document.createElement('div');
            d.className = 'section-separator';
            return d;
        };
        panelElement = document.createElement('div');
        panelElement.className = 'container';
        panelElement.append(
            fiveHourSectionElement, makeSep(),
            sevenDaySectionElement, makeSep(),
            monthlySectionElement,  makeSep(),
            buttonsGroup
        );
        shadow.appendChild(panelElement);
        document.body.appendChild(widget);

        /* Restore saved state (position + mode) */
        state = loadState();
        applyMode(state.mode || 'vertical');

        applyTheme();
        setWidgetPending(true);
        setFetchStatus('idle');
        makeDraggable(widget);

        /* Keep widget fully on-screen when the viewport resizes (e.g. DevTools opens) */
        window.addEventListener('resize', clampWidgetPosition);
    }

    /**
     * Reads html[data-mode] and applies the matching theme class to the widget.
     * @returns {void}
     */
    function applyTheme() {
        if (!widget) return;
        const mode = document.documentElement.getAttribute('data-mode');
        widget.classList.toggle(DARK_CLASS,  mode !== 'light');
        widget.classList.toggle(LIGHT_CLASS, mode === 'light');
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
        [fiveHourValueElement, sevenDayValueElement, monthlyValueElement, monthlyUtilElement]
        .forEach(el => {
            if (!el) return;
            el.classList.remove('is-loading', 'is-failed');
            if (status === 'loading') el.classList.add('is-loading');
            if (status === 'failed')  el.classList.add('is-failed');
            if (status === 'loading' || status === 'failed') {
                el.classList.remove('warn-5h', 'warn-7d');
            }
        });

        if (monthlyValueElement) monthlyValueElement.style.color = '';
        if (monthlyUtilElement)  monthlyUtilElement.style.color  = '';
        if (monthlyLabelElement)
            monthlyLabelElement.classList.remove('label-disabled', 'label-exceeded');

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
     * Makes the widget draggable along the axis appropriate for the current mode:
     * - vertical mode: Y-axis only (constrained within viewport height)
     * - horizontal mode: X-axis only (constrained within viewport width)
     * Persists the final position to state/localStorage on mouseup.
     * @param {HTMLElement} draggableElement
     * @returns {void}
     */
    function makeDraggable(draggableElement) {
        /** @type {number} */ let startX = 0;
        /** @type {number} */ let startY = 0;
        /** @type {number} */ let startLeft = 0;
        /** @type {number} */ let startTop = 0;
        /** @type {boolean} */ let active = false;
        /** @type {boolean} */ let dragMoved = false;

        draggableElement.addEventListener('mousedown',
        (/** @type {MouseEvent} */ event) => {
            if (event.button !== 0) return;
            active = true;
            dragMoved = false;
            startX = event.clientX;
            startY = event.clientY;
            const rect = draggableElement.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            draggableElement.style.transform = 'none';
            if (currentMode === 'horizontal') {
                draggableElement.style.left = startLeft + 'px';
            } else {
                draggableElement.style.top = startTop + 'px';
            }
            event.preventDefault();
        });

        document.addEventListener('mousemove',
        (/** @type {MouseEvent} */ event) => {
            if (!active) return;
            if (currentMode === 'horizontal') {
                const deltaX = event.clientX - startX;
                if (Math.abs(deltaX) > 4) dragMoved = true;
                const clamped = Math.max(0, Math.min(
                    window.innerWidth - draggableElement.offsetWidth,
                    startLeft + deltaX
                ));
                draggableElement.style.left = clamped + 'px';
            } else {
                const deltaY = event.clientY - startY;
                if (Math.abs(deltaY) > 4) dragMoved = true;
                const clamped = Math.max(0, Math.min(
                    window.innerHeight - draggableElement.offsetHeight,
                    startTop + deltaY
                ));
                draggableElement.style.top = clamped + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (active && dragMoved) {
                if (currentMode === 'horizontal') {
                    state.horizontalPositionPx = parseFloat(draggableElement.style.left);
                } else {
                    state.verticalPositionPx = parseFloat(draggableElement.style.top);
                }
                saveState();
            }
            active = false;
        });

        /* Suppress the click that fires after a drag */
        draggableElement.addEventListener('click', (event) => {
            if (dragMoved) { event.stopPropagation(); dragMoved = false; }
        }, true);
    }

    /* ─────────────────────────── fetch ─────────────────────────── */

    /**
     * @typedef {{ utilization: number, resets_at: string }} Period
     * @typedef {{ five_hour: Period, seven_day: Period }} UsageData
     * @typedef {{ is_enabled: boolean, monthly_credit_limit: number, currency: string, used_credits: number, disabled_reason: string|null, disabled_until: string|null }} OverageData
     */

    /**
     * Fetches current usage stats and overage spend limit from the Claude API and updates the widget.
     * @returns {Promise<void>}
     */
    async function fetchStats() {
        if (!organizationId) return;
        setFetchStatus('loading');
        try {
            const makeRequest = (path) => new Request(
                `https://claude.ai/api/organizations/${organizationId}/${path}`,
                {
                    credentials: /** @type {RequestCredentials} */ ('include'),
                    headers: {
                        'User-Agent': navigator.userAgent,
                        'Accept': '*/*',
                        'Accept-Language': navigator.languages.join(','),
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
                }
            );

            const [usageResponse, overageResponse] = await Promise.all([
                fetch(makeRequest('usage')),
                fetch(makeRequest('overage_spend_limit')),
            ]);
            if (!usageResponse.ok) throw new Error('HTTP ' + usageResponse.status);

            const [data, overage] = /** @type {[UsageData, OverageData|null]} */ (
                await Promise.all([
                    usageResponse.json(),
                    overageResponse.ok ? overageResponse.json() : Promise.resolve(null),
                ])
            );
            console.debug('[claude-ai-usage-widget] usage data:', data);
            console.debug('[claude-ai-usage-widget] overage data:', overage);

            /* --- 5h / 7d --- */
            const fiveHourPct       = formatPercent(data?.five_hour?.utilization);
            const sevenDayPct       = formatPercent(data?.seven_day?.utilization);
            const fiveHourCountdown = formatTimeUntilReset(data?.five_hour?.resets_at);
            const sevenDayCountdown = formatTimeUntilReset(data?.seven_day?.resets_at);
            const fiveHourResetFull = formatResetTime(data?.five_hour?.resets_at);
            const sevenDayResetFull = formatResetTime(data?.seven_day?.resets_at);

            if (fiveHourValueElement)     fiveHourValueElement.textContent     = fiveHourPct;
            if (fiveHourCountdownElement) fiveHourCountdownElement.textContent = fiveHourCountdown;
            if (sevenDayValueElement)     sevenDayValueElement.textContent     = sevenDayPct;
            if (sevenDayCountdownElement) sevenDayCountdownElement.textContent = sevenDayCountdown;

            /* --- Monthly (overage endpoint) --- */
            const overageEnabled  = overage?.is_enabled === true;
            const disabledUntilRaw = overage?.disabled_until ?? null;
            const overageExceeded = overageEnabled && disabledUntilRaw != null;
            const rawUsedCredits  = overageEnabled ? (overage?.used_credits           ?? null) : null;
            const rawCreditLimit  = overageEnabled ? (overage?.monthly_credit_limit   ?? null) : null;
            const overageUtilization = (rawUsedCredits != null && rawCreditLimit != null && rawCreditLimit > 0)
                ? (rawUsedCredits / rawCreditLimit) * 100 : null;

            /* Effective reset: disabled_until directly when set, otherwise first of next month */
            const now = new Date();
            const effectiveResetIso = disabledUntilRaw
                ?? new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
            const effectiveResetDate = new Date(effectiveResetIso);
            const monthPeriodMs = effectiveResetDate.getTime()
                - new Date(now.getFullYear(), now.getMonth(), 1).getTime();

            if (monthlyValueElement)
                monthlyValueElement.textContent = overageEnabled ? formatDollars(rawUsedCredits) : '--';
            if (monthlyUtilElement)
                monthlyUtilElement.textContent = overageEnabled ? formatTimeUntilReset(effectiveResetIso) : '--';

            lastUpdated = new Date();
            setFetchStatus('ok'); /* clears inline color, label-disabled, label-exceeded, warn-reset */

            /* Monthly value + countdown: shared green → orange → red colour */
            const monthlyColor = (overageEnabled && overageUtilization != null)
                ? monthlySpendColor(overageUtilization, overageExceeded) : '';
            if (monthlyValueElement) monthlyValueElement.style.color = monthlyColor;
            if (monthlyUtilElement)  monthlyUtilElement.style.color  = monthlyColor;

            /* MS label: grey when feature off; matte red when limit exceeded */
            if (monthlyLabelElement) {
                monthlyLabelElement.classList.toggle(
                    'label-disabled', !overageEnabled && !overageExceeded
                );
                monthlyLabelElement.classList.toggle('label-exceeded', overageExceeded);
            }

            /* 5h / 7d threshold colours */
            const fiveHourOver = (data?.five_hour?.utilization ?? 0) > 75;
            const sevenDayOver = (data?.seven_day?.utilization ?? 0) > 75;
            if (fiveHourValueElement)
                fiveHourValueElement.classList.toggle('warn-5h', fiveHourOver);
            if (sevenDayValueElement)
                sevenDayValueElement.classList.toggle('warn-7d', sevenDayOver);

            /* --- Tooltips --- */
            const fiveHourPeriodMs = 5 * 60 * 60 * 1000;
            const sevenDayPeriodMs = 7 * 24 * 60 * 60 * 1000;

            if (fiveHourSectionElement) {
                fiveHourSectionElement.title = [
                    'usage:     ' + fiveHourPct,
                    'resets in: ' + fiveHourCountdown,
                    'resets at: ' + fiveHourResetFull,
                    'elapsed:   ' + periodElapsed(data?.five_hour?.resets_at, fiveHourPeriodMs),
                ].join('\n');
            }
            if (sevenDaySectionElement) {
                const sevenDayDate = data?.seven_day?.resets_at
                    ? new Date(data.seven_day.resets_at) : null;
                const sevenDayOfWeek = (sevenDayDate && !isNaN(sevenDayDate.getTime()))
                    ? sevenDayDate.toLocaleDateString([], { weekday: 'long' }) : '';
                sevenDaySectionElement.title = [
                    'usage:     ' + sevenDayPct,
                    'resets in: ' + sevenDayCountdown,
                    'resets at: ' + [sevenDayResetFull, sevenDayOfWeek]
                        .filter(Boolean).join(' '),
                    'elapsed:   ' + periodElapsed(data?.seven_day?.resets_at, sevenDayPeriodMs),
                ].join('\n');
            }
            if (monthlySectionElement && overage) {
                const spendStr = overageEnabled && rawUsedCredits != null
                    ? '$' + (rawUsedCredits / 100).toFixed(2) : '--';
                const limitStr = overageEnabled && rawCreditLimit != null
                    ? '$' + (rawCreditLimit / 100).toFixed(2) : '--';
                const currency   = overage?.currency ?? '';
                const utilStr    = overageUtilization != null
                    ? formatPercent(overageUtilization) : '--';
                const resetInStr = overageEnabled
                    ? formatTimeUntilReset(effectiveResetIso) : '--';
                const resetAtStr = overageEnabled
                    ? formatResetTime(effectiveResetIso) : '--';
                const resetDayOfWeek = overageEnabled && !isNaN(effectiveResetDate.getTime())
                    ? effectiveResetDate.toLocaleDateString([], { weekday: 'long' }) : '';
                const monthElapsed = overageEnabled
                    ? periodElapsed(effectiveResetIso, monthPeriodMs) : '--';
                const disabledReason = overage?.disabled_reason;
                const reasonStr      = disabledReason
                    ? disabledReason.replace(/_/g, ' ')
                        .replace(/^./, (/** @type {string} */ c) => c.toUpperCase())
                    : null;
                monthlySectionElement.title = [
                    'utilization:  ' + utilStr,
                    'resets in:    ' + resetInStr,
                    'resets at:    ' + [resetAtStr, resetDayOfWeek].filter(Boolean).join(' '),
                    'elapsed:      ' + monthElapsed,
                    'spend:        ' + spendStr + ' / ' + limitStr
                        + (currency ? ' ' + currency : ''),
                    ...(reasonStr ? ['reason:       ' + reasonStr] : []),
                ].join('\n');
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
     * Watches html[data-mode] for changes and re-applies the theme class on the widget.
     * @returns {void}
     */
    function startThemeObserver() {
        new MutationObserver(() => applyTheme()).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ['data-mode'] }
        );
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
        startThemeObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
