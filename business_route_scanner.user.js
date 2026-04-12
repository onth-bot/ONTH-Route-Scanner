// ==UserScript==
// @name         Business Route Scanner - Enhanced
// @namespace    http://tampermonkey.net/
// @version      2.4.1
// @description  Scan routes for business, apartment, and problem stops with duration tracking and difficulty scoring
// @author       You
// @match        https://logistics.amazon.com/operations/execution/dv/routes*
// @downloadURL  https://raw.githubusercontent.com/onth-bot/ONTH-Route-Scanner/main/business_route_scanner.user.js
// @updateURL    https://raw.githubusercontent.com/onth-bot/ONTH-Route-Scanner/main/business_route_scanner.user.js
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════════════════════════════════════ */

  const CONFIG = {
    VERSION: '2.4.1',
    BUSINESS_KEYWORDS: [
      "SUITE", "STE", "STE.", "STE#", "BLDG", "BUILDING", "FLOOR", "FL ",
      "OFFICE", "ROOM", "DEPT", "DEPARTMENT", "LLC", "INC", "CORP", "LTD",
      "GROUP", "HOLDINGS", "ENTERPRISES", "HOSPITAL", "CLINIC", "MEDICAL",
      "DENTAL", "BANK", "HOTEL", "MOTEL", "INN"
    ],
    APT_KEYWORDS: ["APT", "APT.", "APT#", "UNIT", "UNIT#", "#", "PH", "PENTHOUSE"],

    // ── Problem addresses to watch for ──────────────────────────────────
    PROBLEM_ADDRESSES: [
      "5090 N PRIMITIVO WAY",
      "5164 N PRIMITIVO WAY",
      "5180 N PRIMITIVO WAY",
      "195 N COVENTRY AVE",
      "190 N COVENTRY AVE",
      "OLD FRIANT RD"
    ],

    // ── Station address to exclude from business flagging ───────────────
    STATION_EXCLUDE: [
      "825 NORTH CLOVIS",
      "825 N CLOVIS",
      "825 N. CLOVIS",
      "825 CLOVIS"
    ],

    TIMEOUTS: {
      ROUTE_LOAD: 8000,
      ROUTE_LIST: 5000,
      SCROLL_DELAY: 150,
      CLICK_DELAY: 100,
      POLL_INTERVAL: 80
    },
    SCROLL: {
      INCREMENT: 600,
      MAX_ATTEMPTS: 50
    },
    MAX_RECURSION_DEPTH: 15,
    MAX_LOG_ENTRIES: 100,
    // Difficulty calculation weights
    DIFFICULTY: {
      FLAGGED_WEIGHT: 0.65,    // 65% weight to flagged stops percentage
      DURATION_WEIGHT: 0.35,   // 35% weight to route duration
      BASELINE_DURATION: 25200 // 6 hours in seconds (baseline expected duration)
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════════
     UTILITY FUNCTIONS
  ═══════════════════════════════════════════════════════════════════════════ */

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const normalize = (str) => String(str || "").toUpperCase().trim();

  const sanitizeCSV = (str) => {
    if (str === null || str === undefined) return "";
    const s = String(str);
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "N/A";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  function calculateDifficulty(flaggedPercent, routeDurationSeconds) {
    const normalizedFlagged = Math.min(flaggedPercent, 100);
    const durationRatio = routeDurationSeconds / CONFIG.DIFFICULTY.BASELINE_DURATION;
    const normalizedDuration = Math.min(durationRatio * 100, 200);
    const difficulty = (
      (normalizedFlagged * CONFIG.DIFFICULTY.FLAGGED_WEIGHT) +
      (normalizedDuration * CONFIG.DIFFICULTY.DURATION_WEIGHT)
    );
    return Math.min(Math.round(difficulty), 100);
  }

  async function waitFor(predicate, timeout = 5000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (predicate()) return true;
      } catch (e) { /* ignore */ }
      await sleep(interval);
    }
    return false;
  }

  /** Check if an address matches any problem address */
  function checkProblemAddress(addressStr) {
    const norm = normalize(addressStr);
    for (const prob of CONFIG.PROBLEM_ADDRESSES) {
      if (norm.includes(prob)) return prob;
    }
    return null;
  }

  /** Check if an address is the station (should be excluded from business) */
  function isStationAddress(addressStr, nameStr) {
    const norm = normalize(addressStr) + " " + normalize(nameStr);
    for (const station of CONFIG.STATION_EXCLUDE) {
      if (norm.includes(station)) return true;
    }
    return false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     UI IMPLEMENTATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function createUI() {
    const existing = document.getElementById('business-scanner-panel');
    if (existing) {
      existing._cleanup?.();
      existing.remove();
    }

    if (!document.getElementById('brs-fonts')) {
      const fontLink = document.createElement('link');
      fontLink.id = 'brs-fonts';
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
      document.head.appendChild(fontLink);
    }

    const panel = document.createElement('div');
    panel.id = 'business-scanner-panel';
    panel.innerHTML = `
      <style>
  #business-scanner-panel {
    /* ── Premium dark + gold palette (from color_scheme.txt) ───────────── */
    --brs-bg-body: #0a0a0a;
    --brs-bg-base: #111214;          /* hero */
    --brs-bg-elevated: #18191d;      /* cards */
    --brs-bg-hover: #222328;         /* subtle lift */
    --brs-text-primary: #f0efe8;     /* warm off-white */
    --brs-text-secondary: #c8c8c8;   /* card body */
    --brs-text-muted: #78797f;       /* labels */
    --brs-accent: #f5c518;           /* gold */
    --brs-accent-hover: #e6b512;     /* slightly deeper gold */
    --brs-border: #2a2c31;
    --brs-border-subtle: rgba(42, 44, 49, 0.65);

    /* ── Semantic (muted, consistent with dark theme) ──────────────────── */
    --brs-success: #72dda0;
    --brs-warning: #f5b880;
    --brs-error: #f0a0a0;
    --brs-info: #e0cc78;

    /* gold tints */
    --brs-accent-bg: rgba(245, 197, 24, 0.08);
    --brs-accent-border: rgba(245, 197, 24, 0.22);
    --brs-accent-glow: rgba(245, 197, 24, 0.35);

    position: fixed;
    top: 16px;
    right: 16px;
    width: 340px;

    /* keep glassy feel but match darker palette */
    background: rgba(17, 18, 20, 0.88);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);

    border-radius: 12px;
    color: var(--brs-text-primary);
    z-index: 2147483647;
    border: 1px solid var(--brs-border-subtle);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55),
                inset 0 1px 0 rgba(245, 197, 24, 0.06);
    font-size: 13px;
    overflow: hidden;
    animation: brs-slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes brs-slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .brs-header {
    padding: 12px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;

    background: linear-gradient(
      180deg,
      rgba(24, 25, 29, 0.72) 0%,
      rgba(17, 18, 20, 0) 100%
    );

    border-bottom: 1px solid rgba(42, 44, 49, 0.75);
    cursor: grab;
    user-select: none;
  }

  .brs-header:active {
    cursor: grabbing;
  }

  .brs-title {
    font-weight: 700;
    font-size: 15px;
    color: var(--brs-text-primary);
    letter-spacing: -0.02em;
  }

  .brs-header-actions {
    display: flex;
    gap: 6px;
  }

  .brs-header-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--brs-text-muted);
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .brs-header-btn:hover {
    background: rgba(245, 197, 24, 0.08);
    color: var(--brs-text-primary);
    transform: translateY(-1px);
    box-shadow: inset 0 0 0 1px rgba(245, 197, 24, 0.12);
  }

  .brs-header-btn.brs-close:hover {
    background: rgba(240, 160, 160, 0.14);
    color: var(--brs-error);
    box-shadow: inset 0 0 0 1px rgba(240, 160, 160, 0.16);
  }

  .brs-status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;

    background: linear-gradient(
      135deg,
      rgba(245, 197, 24, 0.08) 0%,
      rgba(17, 18, 20, 0) 100%
    );

    border-bottom: 1px solid rgba(42, 44, 49, 0.75);
  }

  .brs-status-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--brs-text-muted);
    transition: all 0.3s ease;
  }

  .brs-status-indicator.ready {
    background: var(--brs-success);
    box-shadow: 0 0 10px rgba(114, 221, 160, 0.35);
  }

  .brs-status-indicator.running {
    background: var(--brs-accent);
    box-shadow: 0 0 12px var(--brs-accent-glow);
    animation: brs-pulse 1.5s ease-in-out infinite;
  }

  .brs-status-indicator.warning {
    background: var(--brs-warning);
    box-shadow: 0 0 10px rgba(245, 184, 128, 0.35);
  }

  .brs-status-indicator.error {
    background: var(--brs-error);
    box-shadow: 0 0 10px rgba(240, 160, 160, 0.35);
  }

  @keyframes brs-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .brs-status-text {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    color: var(--brs-text-secondary);
  }

  .brs-status-mode {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;

    background: rgba(245, 197, 24, 0.06);
    color: var(--brs-text-muted);
    border: 1px solid rgba(245, 197, 24, 0.18);

    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .brs-controls {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .brs-btn-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .brs-btn {
    position: relative;
    padding: 10px 14px;
    border-radius: 7px;
    border: none;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 12px;
    color: #111214; /* dark text on gold/secondary */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.15s ease;
    overflow: hidden;
  }

  .brs-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255,255,255,0.14) 0%, transparent 55%);
    pointer-events: none;
  }

  .brs-btn:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .brs-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .brs-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none !important;
  }

  /* Primary = gold */
  .brs-btn-primary {
    background: linear-gradient(135deg, var(--brs-accent) 0%, #d6aa10 100%);
    box-shadow: 0 6px 18px rgba(245, 197, 24, 0.22);
  }

  .brs-btn-primary:hover:not(:disabled) {
    box-shadow: 0 8px 24px rgba(245, 197, 24, 0.28);
  }

  /* Secondary = charcoal w/ gold border */
  .brs-btn-secondary {
    color: var(--brs-text-primary);
    background: linear-gradient(135deg, #1b1c20 0%, #141518 100%);
    border: 1px solid rgba(245, 197, 24, 0.22);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  }

  .brs-btn-secondary:hover:not(:disabled) {
    background: linear-gradient(135deg, #202127 0%, #16171b 100%);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
  }

  .brs-stop-btn {
    flex: 1;
    padding: 8px 12px;
    background: rgba(24, 25, 29, 0.55);
    border: 1px solid var(--brs-border);
    border-radius: 7px;
    color: var(--brs-text-secondary);
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    transition: all 0.15s ease;
  }

  .brs-stop-btn:hover:not(:disabled) {
    background: rgba(240, 160, 160, 0.10);
    border-color: rgba(240, 160, 160, 0.40);
    color: var(--brs-error);
    transform: translateY(-1px);
  }

  .brs-stop-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .brs-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    padding: 8px 14px 12px;
  }

  .brs-stat {
    background: rgba(24, 25, 29, 0.45);
    border: 1px solid rgba(42, 44, 49, 0.85);
    border-radius: 8px;
    padding: 10px 6px;
    text-align: center;
    transition: all 0.15s ease;
  }

  .brs-stat:hover {
    background: rgba(24, 25, 29, 0.62);
    border-color: rgba(245, 197, 24, 0.22);
    transform: translateY(-1px);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
  }

  .brs-stat-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--brs-text-primary);
    line-height: 1;
  }

  /* keep semantic meaning but warm/gold-friendly */
  .brs-stat.business .brs-stat-value { color: var(--brs-accent); }
  .brs-stat.apartment .brs-stat-value { color: var(--brs-warning); }
  .brs-stat.problem .brs-stat-value { color: var(--brs-error); }
  .brs-stat.routes .brs-stat-value { color: var(--brs-success); }

  .brs-stat-label {
    font-size: 9px;
    font-weight: 600;
    color: var(--brs-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-top: 5px;
  }

  .brs-progress-section {
    padding: 0 14px 12px;
  }

  .brs-progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .brs-progress-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--brs-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .brs-progress-value {
    font-size: 10px;
    font-weight: 600;
    color: var(--brs-accent);
  }

  .brs-progress-track {
    height: 5px;
    background: rgba(245, 197, 24, 0.06);
    border-radius: 999px;
    overflow: hidden;
    position: relative;
    border: 1px solid rgba(245, 197, 24, 0.18);
  }

  .brs-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--brs-accent), #d6aa10);
    border-radius: 999px;
    width: 0%;
    transition: width 0.3s ease;
    position: relative;
    box-shadow: 0 0 14px rgba(245, 197, 24, 0.35);
  }

  .brs-progress-fill.active::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.26), transparent);
    animation: brs-shimmer 1.5s ease-in-out infinite;
  }

  @keyframes brs-shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .brs-log-section {
    padding: 12px 14px 14px;
    border-top: 1px solid rgba(42, 44, 49, 0.75);
  }

  .brs-log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .brs-log-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--brs-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .brs-log-clear {
    font-size: 10px;
    font-weight: 600;
    padding: 3px 8px;
    background: rgba(245, 197, 24, 0.06);
    border: 1px solid rgba(245, 197, 24, 0.18);
    border-radius: 5px;
    color: var(--brs-text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .brs-log-clear:hover {
    border-color: rgba(245, 197, 24, 0.28);
    color: var(--brs-text-secondary);
    background: rgba(245, 197, 24, 0.10);
    transform: translateY(-1px);
  }

  .brs-log {
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(42, 44, 49, 0.85);
    border-radius: 8px;
    height: 100px;
    overflow-y: auto;
    font-size: 11px;
    scrollbar-width: thin;
    scrollbar-color: rgba(245, 197, 24, 0.18) transparent;
  }

  .brs-log::-webkit-scrollbar {
    width: 5px;
  }

  .brs-log::-webkit-scrollbar-track {
    background: transparent;
  }

  .brs-log::-webkit-scrollbar-thumb {
    background: rgba(245, 197, 24, 0.18);
    border-radius: 999px;
  }

  .brs-log::-webkit-scrollbar-thumb:hover {
    background: rgba(245, 197, 24, 0.28);
  }

  .brs-log-entry {
    padding: 6px 10px;
    display: flex;
    gap: 8px;
    border-bottom: 1px solid rgba(42, 44, 49, 0.75);
    animation: brs-fadeIn 0.2s ease;
  }

  @keyframes brs-fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .brs-log-entry:last-child {
    border-bottom: none;
  }

  .brs-log-time {
    color: var(--brs-text-muted);
    font-weight: 500;
    min-width: 58px;
    flex-shrink: 0;
    font-size: 10px;
  }

  .brs-log-msg {
    flex: 1;
    word-break: break-word;
    line-height: 1.35;
    color: var(--brs-text-secondary);
  }

  .brs-log-msg.info { color: var(--brs-text-secondary); }
  .brs-log-msg.success { color: var(--brs-success); }
  .brs-log-msg.warning { color: var(--brs-warning); }
  .brs-log-msg.error { color: var(--brs-error); }

  #business-scanner-panel.minimized .brs-status-bar,
  #business-scanner-panel.minimized .brs-controls,
  #business-scanner-panel.minimized .brs-stats,
  #business-scanner-panel.minimized .brs-progress-section,
  #business-scanner-panel.minimized .brs-log-section {
    display: none;
  }

  #business-scanner-panel.minimized {
    width: auto;
  }

  #business-scanner-panel.minimized .brs-header {
    border-bottom: none;
  }

  @media (max-height: 700px) {
    .brs-log {
      height: 70px;
    }
  }
</style>

      <div class="brs-header" id="brs-drag-handle">
        <div class="brs-title">Route Scanner</div>
        <div class="brs-header-actions">
          <button class="brs-header-btn brs-min" id="brs-min" title="Minimize">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="brs-header-btn brs-close" id="brs-close" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="brs-status-bar">
        <div class="brs-status-indicator ready" id="brs-status-dot"></div>
        <span class="brs-status-text" id="brs-status-text">Ready to scan</span>
        <span class="brs-status-mode" id="brs-status-mode">Standby</span>
      </div>

      <div class="brs-controls">
        <div class="brs-btn-row">
          <button id="brs-scan-all" class="brs-btn brs-btn-primary">
            <span>⚡</span>
            <span>Scan All</span>
          </button>
          <button id="brs-scan-remaining" class="brs-btn brs-btn-secondary">
            <span>🔍</span>
            <span>Remaining</span>
          </button>
        </div>
        <div class="brs-options-row" style="display: flex; gap: 8px;">
          <button id="brs-stop" class="brs-stop-btn" disabled>
            <span>◼</span>
            <span>Stop Scan</span>
          </button>
        </div>
      </div>

      <div class="brs-stats">
        <div class="brs-stat business">
          <div class="brs-stat-value" id="brs-stat-business">0</div>
          <div class="brs-stat-label">Business</div>
        </div>
        <div class="brs-stat apartment">
          <div class="brs-stat-value" id="brs-stat-apartment">0</div>
          <div class="brs-stat-label">Apartment</div>
        </div>
        <div class="brs-stat problem">
          <div class="brs-stat-value" id="brs-stat-problem">0</div>
          <div class="brs-stat-label">Problem</div>
        </div>
        <div class="brs-stat routes">
          <div class="brs-stat-value" id="brs-stat-routes">0</div>
          <div class="brs-stat-label">Routes</div>
        </div>
      </div>

      <div class="brs-progress-section" id="brs-progress-section" style="display: none;">
        <div class="brs-progress-header">
          <span class="brs-progress-label">Progress</span>
          <span class="brs-progress-value" id="brs-progress-text">0 / 0</span>
        </div>
        <div class="brs-progress-track">
          <div class="brs-progress-fill" id="brs-progress-fill"></div>
        </div>
      </div>

      <div class="brs-log-section">
        <div class="brs-log-header">
          <span class="brs-log-title">Activity Log</span>
          <button class="brs-log-clear" id="brs-log-clear">Clear</button>
        </div>
        <div class="brs-log" id="brs-log"></div>
      </div>
    `;

    document.body.appendChild(panel);

    const $ = id => document.getElementById(id);
    const scanAllBtn = $('brs-scan-all');
    const scanRemainingBtn = $('brs-scan-remaining');
    const stopBtn = $('brs-stop');
    const logEl = $('brs-log');
    const statBusiness = $('brs-stat-business');
    const statApartment = $('brs-stat-apartment');
    const statProblem = $('brs-stat-problem');
    const statRoutes = $('brs-stat-routes');
    const statusDot = $('brs-status-dot');
    const statusText = $('brs-status-text');
    const statusMode = $('brs-status-mode');
    const progressSection = $('brs-progress-section');
    const progressFill = $('brs-progress-fill');
    const progressText = $('brs-progress-text');
    const logClearBtn = $('brs-log-clear');

    function setStatus(state, text, mode) {
      statusDot.className = 'brs-status-indicator ' + state;
      statusText.textContent = text;
      statusMode.textContent = mode;
    }

    function addLog(msg, type = 'info') {
      const div = document.createElement('div');
      div.className = 'brs-log-entry';
      const time = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      const timeSpan = document.createElement('span');
      timeSpan.className = 'brs-log-time';
      timeSpan.textContent = time;

      const msgSpan = document.createElement('span');
      msgSpan.className = 'brs-log-msg ' + type;
      msgSpan.textContent = msg;

      div.appendChild(timeSpan);
      div.appendChild(msgSpan);

      if (logEl.firstChild) {
        logEl.insertBefore(div, logEl.firstChild);
      } else {
        logEl.appendChild(div);
      }

      while (logEl.children.length > CONFIG.MAX_LOG_ENTRIES) {
        logEl.removeChild(logEl.lastChild);
      }
    }

    function updateStats(business, apartment, problem, routes) {
      statBusiness.textContent = business;
      statApartment.textContent = apartment;
      statProblem.textContent = problem;
      statRoutes.textContent = routes;
    }

    function setProgress(current, total) {
      if (total > 0) {
        progressSection.style.display = 'block';
        const pct = Math.round((current / total) * 100);
        progressFill.style.width = pct + '%';
        progressFill.classList.add('active');
        progressText.textContent = `${current} / ${total}`;
      } else {
        progressSection.style.display = 'none';
        progressFill.classList.remove('active');
      }
    }

    logClearBtn.onclick = () => {
      logEl.innerHTML = '';
      addLog('Log cleared', 'info');
    };

    addLog('Scanner initialized v' + CONFIG.VERSION, 'success');
    addLog(`Tracking ${CONFIG.PROBLEM_ADDRESSES.length} problem addresses`, 'info');

    let running = false;
    const state = { stopRequested: false };

    async function startScan(onlyRemaining) {
      if (running) return;
      running = true;
      state.stopRequested = false;

      scanAllBtn.disabled = scanRemainingBtn.disabled = true;
      stopBtn.disabled = false;

      const modeLabel = onlyRemaining ? 'Remaining' : 'Full Scan';
      setStatus('running', 'Scanning in progress...', modeLabel);
      addLog(onlyRemaining ? 'Starting remaining stops scan...' : 'Starting full route scan...', 'info');
      updateStats(0, 0, 0, 0);

      try {
        await runScraper(
          addLog,
          () => state.stopRequested,
          onlyRemaining,
          setProgress,
          updateStats
        );
      } catch (e) {
        addLog(`Error: ${e.message}`, 'error');
        console.error('Scanner error:', e);
        setStatus('error', 'Scan failed', 'Error');
      } finally {
        running = false;
        scanAllBtn.disabled = scanRemainingBtn.disabled = false;
        stopBtn.disabled = true;
        setProgress(0, 0);
        if (!state.stopRequested) {
          setStatus('ready', 'Scan complete', 'Standby');
        }
      }
    }

    scanAllBtn.onclick = () => startScan(false);
    scanRemainingBtn.onclick = () => startScan(true);

    stopBtn.onclick = () => {
      state.stopRequested = true;
      stopBtn.disabled = true;
      setStatus('warning', 'Stopping scan...', 'Stopping');
      addLog('Stop requested by user', 'warning');
    };

    $('brs-min').onclick = e => {
      e.stopPropagation();
      panel.classList.toggle('minimized');
      const isMin = panel.classList.contains('minimized');
      $('brs-min').innerHTML = isMin
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    };

    $('brs-close').onclick = () => {
      panel.classList.add('closing');
      panel.style.animation = 'brs-slideIn 0.2s ease reverse';
      setTimeout(() => {
        panel._cleanup?.();
        panel.remove();
      }, 200);
    };

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startLeft = 0;
    let startTop = 0;

    $('brs-drag-handle').onmousedown = e => {
      if (e.target.closest('.brs-header-btn')) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      e.preventDefault();
    };

    const onMouseMove = e => {
      if (!isDragging) return;
      const newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + e.clientX - dragStartX));
      const newTop = Math.max(0, Math.min(window.innerHeight - 60, startTop + e.clientY - dragStartY));
      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    panel._cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DOM HELPERS
  ═══════════════════════════════════════════════════════════════════════════ */

  function findScrollContainer() {
    const selectors = [
      ".ReactVirtualized__Grid",
      "[data-testid='virtual-list']",
      ".fp-page-template",
      "main"
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.scrollHeight > el.clientHeight + 50) {
        return el;
      }
    }

    for (const div of document.querySelectorAll('div')) {
      if (div.scrollHeight > window.innerHeight && div.clientHeight > 400) {
        return div;
      }
    }

    return document.documentElement;
  }

  function isOnRouteList() {
    const hasTitles = document.querySelectorAll('p[title]').length > 0;
    const hasStopsText = document.body.innerText.includes('stops') ||
                        document.body.innerText.includes('deliveries');
    return hasTitles && hasStopsText;
  }

  function isRouteDetailLoaded() {
    const stopSelectors = 'div[class*="stop"], div[class*="card"], div[class*="task"], div[data-index]';
    for (const el of document.querySelectorAll(stopSelectors)) {
      const key = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactProps')
      );
      if (key) {
        const stopData = findStopData(el[key], 0, new WeakSet());
        if (stopData) return true;
      }
    }
    return false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     KEYWORD MATCHING
  ═══════════════════════════════════════════════════════════════════════════ */

  function checkKeywords(addressStr, nameStr, keywordList) {
    const fullText = (normalize(addressStr) + " " + normalize(nameStr)).replace(/[.,]/g, " ");
    const tokenizedText = " " + fullText + " ";

    for (const word of keywordList) {
      if (word === "#") {
        if (/\s#\d/.test(fullText) || /^#\d/.test(fullText)) {
          return "#";
        }
      } else if (tokenizedText.includes(" " + word + " ")) {
        return word;
      }
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     REACT DATA EXTRACTION
  ═══════════════════════════════════════════════════════════════════════════ */

  function findStopData(obj, depth = 0, visited = new WeakSet()) {
    if (depth > CONFIG.MAX_RECURSION_DEPTH || !obj || typeof obj !== 'object') {
      return null;
    }

    try {
      if (visited.has(obj)) return null;
      visited.add(obj);
    } catch (e) {
      return null;
    }

    if (obj.memoizedProps) {
      const props = obj.memoizedProps;
      const candidateKeys = ['stop', 'task', 'data', 'item', 'delivery'];

      for (const key of candidateKeys) {
        const candidate = props[key];
        if (candidate && typeof candidate === 'object') {
          if (candidate.sequenceNumber !== undefined ||
              candidate.address ||
              candidate.domainMap ||
              candidate.taskId) {
            return candidate;
          }
        }
      }

      if (props.sequenceNumber !== undefined || props.taskId || props.domainMap) {
        return props;
      }
    }

    const fiberKeys = ['return', 'child', 'sibling', 'memoizedState', 'stateNode'];
    for (const key of fiberKeys) {
      if (obj[key] && typeof obj[key] === 'object') {
        const result = findStopData(obj[key], depth + 1, visited);
        if (result) return result;
      }
    }

    return null;
  }

  function extractRouteDuration(obj, routeCode, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;

    try {
      if (obj.routeDuration !== undefined && typeof obj.routeDuration === 'number') {
        const objStr = JSON.stringify(obj).substring(0, 500);
        if (objStr.includes(routeCode) || depth === 0) {
          return obj.routeDuration;
        }
      }

      if (obj.routeCode === routeCode && obj.routeDuration !== undefined) {
        return obj.routeDuration;
      }

      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (item && typeof item === 'object') {
            if (item.routeCode === routeCode && item.routeDuration !== undefined) {
              return item.routeDuration;
            }
          }
        }
      }

      const searchKeys = ['memoizedProps', 'memoizedState', 'return', 'child', 'props', 'data', 'route', 'routes'];
      for (const key of searchKeys) {
        if (obj[key] && typeof obj[key] === 'object') {
          const duration = extractRouteDuration(obj[key], routeCode, depth + 1);
          if (duration !== null) return duration;
        }
      }
    } catch (e) {
      // Ignore errors during deep search
    }

    return null;
  }

  function checkPriorityFlag(stopData) {
    if (!stopData) return false;
    try {
      return JSON.stringify(stopData).includes("PrioritizedBusinessHoursAdherence");
    } catch (e) {
      return false;
    }
  }

  function isStopDelivered(stopData) {
    if (!stopData) return false;

    function searchForDelivered(obj, depth = 0) {
      if (depth > 10 || !obj || typeof obj !== 'object') return false;

      const taskState = String(obj.taskState || "").toUpperCase();
      const execStatus = String(obj.executionStatus || "").toUpperCase();
      const taskContext = String(obj.taskStateContext || "").toUpperCase();

      if (taskState.includes("DELIVERED") &&
          !taskState.includes("NOT_DELIVERED") &&
          !taskState.includes("ATTEMPTED")) {
        return true;
      }

      if (execStatus === "COMPLETE" || execStatus === "COMPLETED") {
        return true;
      }

      if (taskContext.includes("DELIVERED") &&
          !taskContext.includes("NOT_DELIVERED")) {
        return true;
      }

      if (taskState.includes("ATTEMPTED") ||
          execStatus === "ATTEMPTED" ||
          taskState.includes("BUSINESS_CLOSED")) {
        return true;
      }

      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value && typeof value === 'object') {
          if (Array.isArray(value)) {
            for (const item of value) {
              if (searchForDelivered(item, depth + 1)) return true;
            }
          } else {
            if (searchForDelivered(value, depth + 1)) return true;
          }
        }
      }

      return false;
    }

    return searchForDelivered(stopData);
  }

  function extractAddress(stopData) {
    if (!stopData) return "";

    if (stopData.address) {
      if (typeof stopData.address === 'string') return stopData.address;
      if (stopData.address.address1) return stopData.address.address1;
    }

    return stopData.address1 ||
           stopData.domainMap?.address?.address1 ||
           "";
  }

  function extractCustomerName(stopData) {
    if (!stopData) return "";

    return stopData.customerName ||
           stopData.recipientName ||
           stopData.name ||
           stopData.domainMap?.customerName ||
           "";
  }

  function extractSequenceNumber(stopData) {
    if (!stopData) return null;

    if (stopData.sequenceNumber !== undefined) {
      return stopData.sequenceNumber;
    }

    if (stopData.domainMap?.sequenceNumber !== undefined) {
      return stopData.domainMap.sequenceNumber;
    }

    const address = extractAddress(stopData);
    if (address) {
      return address;
    }

    return 'stop_' + Math.random().toString(36).substring(2, 11);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DRIVER NAME VALIDATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function isValidDriverName(text) {
    if (!text || text.length < 2 || text.length > 50) return false;

    const invalidPatterns = [
      /^\d+h\s*\d*m/i,
      /left on shift/i,
      /stops\/hour/i,
      /Avg:/i,
      /Time left/i,
      /^\d+\/\d+/,
      /^\d+:\d+/,
      /^\d+(am|pm)$/i,
      /^stops$/i,
      /^deliveries$/i,
      /not available/i,
      /^[A-Z]{1,4}\d+$/
    ];

    for (const pattern of invalidPatterns) {
      if (pattern.test(text)) return false;
    }

    return /[a-zA-Z]/.test(text);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DATA COLLECTION
  ═══════════════════════════════════════════════════════════════════════════ */

  function getAllStopData(log = null) {
    const stops = [];
    const processedSeqs = new Set();
    let deliveredCount = 0;
    let pendingCount = 0;

    const stopElements = document.querySelectorAll(
      'div[class*="stop"], div[class*="card"], div[class*="task"], div[data-index]'
    );

    for (const el of stopElements) {
      try {
        const key = Object.keys(el).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactProps')
        );
        if (!key) continue;

        const stopData = findStopData(el[key], 0, new WeakSet());
        if (!stopData) continue;

        const seqNum = extractSequenceNumber(stopData);
        if (seqNum === null || processedSeqs.has(seqNum)) continue;

        processedSeqs.add(seqNum);

        const delivered = isStopDelivered(stopData);
        if (delivered) {
          deliveredCount++;
        } else {
          pendingCount++;
        }

        stops.push({
          seqNum,
          address: extractAddress(stopData),
          customerName: extractCustomerName(stopData),
          hasPriorityFlag: checkPriorityFlag(stopData),
          isDelivered: delivered
        });
      } catch (e) {
        console.warn('Error processing stop element:', e);
      }
    }

    if (log) {
      log(`Found ${stops.length} stops (${pendingCount} pending, ${deliveredCount} delivered)`, 'info');
    }

    return stops;
  }

  async function getAllRoutes(log) {
    log('Collecting routes from list...', 'info');

    const routes = new Map();
    const routeDurations = new Map();
    const scroller = findScrollContainer();

    if (scroller) {
      scroller.scrollTop = 0;
    }
    await sleep(200);

    let sameCount = 0;
    let previousSize = 0;

    for (let iteration = 0; iteration < CONFIG.SCROLL.MAX_ATTEMPTS; iteration++) {
      document.querySelectorAll('p[title]').forEach(p => {
        const titleVal = p.getAttribute('title') || "";

        if (!/^[A-Z]{1,4}\d+$/.test(titleVal)) return;

        const parent = p.closest('a.af-link') ||
                      p.closest('div[data-index]') ||
                      p.closest('div[class*="route"]');

        if (!parent) return;

        if (!routeDurations.has(titleVal)) {
          const key = Object.keys(parent).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactProps')
          );

          if (key) {
            const duration = extractRouteDuration(parent[key], titleVal, 0);
            if (duration) {
              routeDurations.set(titleVal, duration);
            }
          }
        }

        let driverName = "Unknown";

        for (const nameP of parent.querySelectorAll('p[title]')) {
          const t = nameP.getAttribute('title') || "";
          if (t !== titleVal && isValidDriverName(t)) {
            driverName = t;
            break;
          }
        }

        if (driverName === "Unknown") {
          for (const el of parent.querySelectorAll('p, span')) {
            const txt = (el.innerText || "").trim();
            if (txt !== titleVal && isValidDriverName(txt) && txt.includes(' ')) {
              driverName = txt;
              break;
            }
          }
        }

        const parentText = parent.innerText || "";
        if (parentText.includes('stops') || parentText.includes('deliveries')) {
          routes.set(titleVal, driverName);
        }
      });

      if (routes.size === previousSize) {
        sameCount++;
        if (sameCount > 3) break;
      } else {
        sameCount = 0;
        if (routes.size % 10 === 0) {
          log(`Found ${routes.size} routes...`, 'info');
        }
      }

      previousSize = routes.size;

      if (scroller) {
        scroller.scrollTop += CONFIG.SCROLL.INCREMENT;
      } else {
        window.scrollBy(0, CONFIG.SCROLL.INCREMENT);
      }

      await sleep(CONFIG.TIMEOUTS.SCROLL_DELAY);
    }

    if (scroller) {
      scroller.scrollTop = 0;
    } else {
      window.scrollTo(0, 0);
    }

    log(`Total routes found: ${routes.size}`, 'success');
    log(`Duration data found for ${routeDurations.size} routes`, 'info');
    return { routes, routeDurations };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MAIN SCRAPER LOGIC
  ═══════════════════════════════════════════════════════════════════════════ */

  async function runScraper(log, shouldStop, onlyRemaining, updateProgress, updateStats) {
    const scanType = onlyRemaining ? "REMAINING" : "ALL";

    const { routes: routesMap, routeDurations } = await getAllRoutes(log);
    const routeCodes = Array.from(routesMap.keys());

    if (routeCodes.length === 0) {
      log('No routes found! Make sure you are on the route list page.', 'error');
      return;
    }

    const businessData = [];
    const aptData = [];
    const problemData = [];
    const driverStats = {};
    const driverTotalStops = {};
    let priorityFlagsFound = 0;
    let totalBusiness = 0;
    let totalApartment = 0;
    let totalProblem = 0;

    for (const code of routeCodes) {
      driverStats[code] = {
        name: routesMap.get(code) || code,
        business: 0,
        apt: 0,
        problem: 0,
        duration: routeDurations.get(code) || 0
      };
      driverTotalStops[code] = new Set();
    }

    log(`Scanning ${routeCodes.length} routes (${scanType})...`, 'info');
    updateProgress(0, routeCodes.length);

    for (let i = 0; i < routeCodes.length; i++) {
      if (shouldStop()) {
        log('Scan stopped by user', 'warning');
        break;
      }

      const code = routeCodes[i];
      const driverName = routesMap.get(code);

      log(`[${i + 1}/${routeCodes.length}] ${code} (${driverName})`, 'info');
      updateProgress(i, routeCodes.length);

      const scroller = findScrollContainer();
      if (scroller) scroller.scrollTop = 0;

      let found = false;

      for (let scrollAttempt = 0; scrollAttempt < 30; scrollAttempt++) {
        const routeLinks = document.querySelectorAll(`p[title="${code}"]`);

        for (const p of routeLinks) {
          const parentLink = p.closest('a.af-link');
          if (parentLink) {
            parentLink.click();
            found = true;
            break;
          }
        }

        if (found) break;

        if (scroller) {
          scroller.scrollTop += CONFIG.SCROLL.INCREMENT;
        } else {
          window.scrollBy(0, CONFIG.SCROLL.INCREMENT);
        }

        await sleep(50);
      }

      if (!found) {
        log(`Could not find route ${code}`, 'warning');
        continue;
      }

      const loaded = await waitFor(
        isRouteDetailLoaded,
        CONFIG.TIMEOUTS.ROUTE_LOAD,
        CONFIG.TIMEOUTS.POLL_INTERVAL
      );

      if (!loaded) {
        log(`Timeout loading route ${code}`, 'warning');
        window.history.back();
        await sleep(500);
        continue;
      }

      await sleep(200);

      // Try to extract duration from detail page if we don't have it yet
      if (!driverStats[code].duration || driverStats[code].duration === 0) {
        const detailElements = document.querySelectorAll('div, section, main');
        for (const el of detailElements) {
          const key = Object.keys(el).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactProps')
          );
          if (key) {
            const duration = extractRouteDuration(el[key], code, 0);
            if (duration) {
              driverStats[code].duration = duration;
              log(`Found duration: ${formatDuration(duration)}`, 'info');
              break;
            }
          }
        }
      }

      const stops = getAllStopData(log);

      for (const stop of stops) {
        if (onlyRemaining && stop.isDelivered) continue;

        driverTotalStops[code].add(stop.seqNum);

        if (stop.hasPriorityFlag) {
          priorityFlagsFound++;
        }

        // ── Check for problem address ─────────────────────────────────
        const problemMatch = checkProblemAddress(stop.address);
        if (problemMatch) {
          driverStats[code].problem++;
          totalProblem++;
          problemData.push({
            Route: code,
            Driver: driverName,
            Stop: stop.seqNum,
            Address: stop.address,
            MatchedAddress: problemMatch
          });
        }

        // ── Skip station address for business flagging ────────────────
        const isStation = isStationAddress(stop.address, stop.customerName);

        // ── Business check (with station exclusion) ───────────────────
        const bizKeyword = checkKeywords(
          stop.address,
          stop.customerName,
          CONFIG.BUSINESS_KEYWORDS
        );

        if (bizKeyword && !isStation) {
          driverStats[code].business++;
          totalBusiness++;
          businessData.push({
            Route: code,
            Driver: driverName,
            Stop: stop.seqNum,
            Address: stop.address,
            Keyword: bizKeyword
          });
        } else if (stop.hasPriorityFlag && !isStation) {
          driverStats[code].business++;
          totalBusiness++;
          businessData.push({
            Route: code,
            Driver: driverName,
            Stop: stop.seqNum,
            Address: stop.address,
            Keyword: "PriorityFlag"
          });
        }

        // ── Apartment check ───────────────────────────────────────────
        const aptKeyword = checkKeywords(
          stop.address,
          stop.customerName,
          CONFIG.APT_KEYWORDS
        );

        if (aptKeyword) {
          driverStats[code].apt++;
          totalApartment++;
          aptData.push({
            Route: code,
            Driver: driverName,
            Stop: stop.seqNum,
            Address: stop.address,
            Keyword: aptKeyword
          });
        }
      }

      const probLabel = driverStats[code].problem > 0
        ? ` / ${driverStats[code].problem} Prob`
        : '';
      log(`✓ ${driverStats[code].business} Biz / ${driverStats[code].apt} Apt${probLabel}`, 'success');
      updateStats(totalBusiness, totalApartment, totalProblem, i + 1);

      const backBtn = document.querySelector('button[aria-label="Back"]');
      if (backBtn) {
        backBtn.click();
      } else {
        window.history.back();
      }

      await waitFor(isOnRouteList, CONFIG.TIMEOUTS.ROUTE_LIST, CONFIG.TIMEOUTS.POLL_INTERVAL);
      await sleep(CONFIG.TIMEOUTS.CLICK_DELAY);
    }

    updateProgress(routeCodes.length, routeCodes.length);
    log(`Scan complete! PriorityFlags: ${priorityFlagsFound} | Problem stops: ${totalProblem}`, 'success');

    generateReports(
      driverStats,
      driverTotalStops,
      businessData,
      aptData,
      problemData,
      log,
      onlyRemaining
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     REPORT GENERATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function generateReports(stats, totalStopsMap, bizList, aptList, problemList, log, onlyRemaining = false) {
    const summaryKeys = Object.keys(stats).sort();
    const reportType = onlyRemaining ? "Remaining" : "All";

    let teamTotalStops = 0;
    let teamTotalBusiness = 0;
    let teamTotalApt = 0;
    let teamTotalProblem = 0;
    let teamTotalDuration = 0;

    for (const key of summaryKeys) {
      teamTotalStops += totalStopsMap[key]?.size || 0;
      teamTotalBusiness += stats[key].business;
      teamTotalApt += stats[key].apt;
      teamTotalProblem += stats[key].problem;
      teamTotalDuration += stats[key].duration || 0;
    }

    const teamTotalFlagged = teamTotalBusiness + teamTotalApt;
    const teamPct = teamTotalStops > 0
      ? ((teamTotalFlagged / teamTotalStops) * 100).toFixed(1)
      : "0.0";

    const totalHeader = onlyRemaining ? "Remaining Stops" : "Total Stops";

    const rows = [];

    // ── Header row 1: Section titles ──────────────────────────────────
    rows.push([
      'Business Stops', '', '', '', '',
      '',
      'Apartment Stops', '', '', '', '',
      '',
      'Problem Stops', '', '', '', '',
      '',
      'Route Summary', '', '', '', '', '', '', '', '', '',
      '',
      'Team Summary', ''
    ].join(','));

    // ── Header row 2: Column titles ───────────────────────────────────
    rows.push([
      'Route', 'Driver', 'Stop', 'Address', 'Keyword',
      '',
      'Route', 'Driver', 'Stop', 'Address', 'Keyword',
      '',
      'Route', 'Driver', 'Stop', 'Address', 'Matched Address',
      '',
      'Route', 'Driver', totalHeader, 'Business Stops', 'Apt Stops', 'Problem Stops', 'Total Flagged', 'Flagged %', 'Duration', 'Difficulty %',
      '',
      'Metric', 'Value'
    ].join(','));

    const maxRows = Math.max(bizList.length, aptList.length, problemList.length, summaryKeys.length, 7);

    for (let i = 0; i < maxRows; i++) {
      const row = [];

      // ── Business columns ────────────────────────────────────────────
      if (i < bizList.length) {
        const b = bizList[i];
        row.push(
          sanitizeCSV(b.Route),
          sanitizeCSV(b.Driver),
          sanitizeCSV(b.Stop),
          sanitizeCSV(b.Address),
          sanitizeCSV(b.Keyword)
        );
      } else {
        row.push('', '', '', '', '');
      }

      row.push('');

      // ── Apartment columns ───────────────────────────────────────────
      if (i < aptList.length) {
        const a = aptList[i];
        row.push(
          sanitizeCSV(a.Route),
          sanitizeCSV(a.Driver),
          sanitizeCSV(a.Stop),
          sanitizeCSV(a.Address),
          sanitizeCSV(a.Keyword)
        );
      } else {
        row.push('', '', '', '', '');
      }

      row.push('');

      // ── Problem columns ─────────────────────────────────────────────
      if (i < problemList.length) {
        const p = problemList[i];
        row.push(
          sanitizeCSV(p.Route),
          sanitizeCSV(p.Driver),
          sanitizeCSV(p.Stop),
          sanitizeCSV(p.Address),
          sanitizeCSV(p.MatchedAddress)
        );
      } else {
        row.push('', '', '', '', '');
      }

      row.push('');

      // ── Route Summary columns (now includes Problem Stops) ──────────
      if (i < summaryKeys.length) {
        const key = summaryKeys[i];
        const s = stats[key];
        const totalStops = totalStopsMap[key]?.size || 0;
        const totalFlagged = s.business + s.apt;
        const flaggedPct = totalStops > 0
          ? ((totalFlagged / totalStops) * 100)
          : 0;
        const flaggedPctStr = flaggedPct.toFixed(1) + '%';

        const durationStr = formatDuration(s.duration);
        const difficultyPct = calculateDifficulty(flaggedPct, s.duration);
        const difficultyPctStr = difficultyPct + '%';

        row.push(
          sanitizeCSV(key),
          sanitizeCSV(s.name),
          totalStops,
          s.business,
          s.apt,
          s.problem,
          totalFlagged,
          flaggedPctStr,
          durationStr,
          difficultyPctStr
        );
      } else {
        row.push('', '', '', '', '', '', '', '', '', '');
      }

      row.push('');

      // ── Team Summary column ─────────────────────────────────────────
      switch (i) {
        case 0:
          row.push(totalHeader, teamTotalStops);
          break;
        case 1:
          row.push('Business Stops', teamTotalBusiness);
          break;
        case 2:
          row.push('Apt Stops', teamTotalApt);
          break;
        case 3:
          row.push('Problem Stops', teamTotalProblem);
          break;
        case 4:
          row.push('Total Flagged', teamTotalFlagged);
          break;
        case 5:
          row.push('Flagged %', `${teamPct}%`);
          break;
        case 6:
          row.push('Total Duration', formatDuration(teamTotalDuration));
          break;
        default:
          row.push('', '');
      }

      rows.push(row.join(','));
    }

    const csvContent = rows.join('\n');
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);

    link.href = URL.createObjectURL(blob);
    link.download = `Routes_${reportType}_Report_${timestamp}.csv`;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }, 100);

    log(`${reportType} report downloaded!`, 'success');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     INITIALIZATION
  ═══════════════════════════════════════════════════════════════════════════ */

  setTimeout(createUI, 800);

})();
