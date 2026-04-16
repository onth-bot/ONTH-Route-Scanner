// ==UserScript==
// @name         Business Route Scanner
// @namespace    http://tampermonkey.net/
// @version      2.9.0
// @description  Scan routes for business, apartment, and problem stops with a dynamic difficulty score. Optimized for absolute maximum speed.
// @author       You & Copilot
// @match        https://logistics.amazon.com/operations/execution/dv/routes*
// @downloadURL  https://raw.githubusercontent.com/onth-bot/ONTH-Route-Scanner/main/business_route_scanner.user.js
// @updateURL    https://raw.githubusercontent.com/onth-bot/ONTH-Route-Scanner/main/business_route_scanner.user.js
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const CONFIG = {
    VERSION: '2.9.0',
    BUSINESS_KEYWORDS: [
      "SUITE","STE","STE.","STE#","BLDG","BUILDING","FLOOR","FL ",
      "OFFICE","ROOM","DEPT","DEPARTMENT","LLC","INC","CORP","LTD",
      "GROUP","HOLDINGS","ENTERPRISES","HOSPITAL","CLINIC","MEDICAL",
      "DENTAL","BANK","HOTEL","MOTEL","INN"
    ],
    APT_KEYWORDS: ["APT","APT.","APT#","UNIT","UNIT#","#","PH","PENTHOUSE"],
    PROBLEM_GROUPS: [
      { label: "Foxhill Apt's",             patterns: ["941 FOXHILL DR", "979 FOXHILL DR"], points: 10 },
      { label: "Copper And Friant Apt's",   patterns: ["COPPER AND FRIANT", "11217 N ALICANTE DR", "11201 N ALICANTE DR"], points: 20 },
      { label: "Saybrook Apt's",            patterns: ["9199 N SAYBROOK", "9263 N SAYBROOK"], points: 10 },
      { label: "Nees Apt's",                patterns: ["2610 E NEES AVE"], points: 10 },
      { label: "Spruce Apt's",              patterns: ["2389 E SPRUCE AVE", "2060 E SPRUCE AVE"], points: 10 },
      { label: "Alluvial Apt's",            patterns: ["2350 E ALLUVIAL AVE"], points: 5 },
      { label: "Fort Washington Apt's",     patterns: ["9525 N FORT WASHINGTON"], points: 10 },
      { label: "Shepard Apt's (The Row)",   patterns: ["2740 E SHEPARD AVE"], points: 10 },
      { label: "Primos",                    patterns: ["PRIMITIVO WAY"], points: 20 },
      { label: "Coventry Apt's",            patterns: ["COVENTRY AVE"], points: 10 },
      { label: "Old Friant Rd",             patterns: ["OLD FRIANT RD"], points: 5 },
      { label: "722 Clovis Apt's",          patterns: ["722 N CLOVIS AVE"], points: 10 }
    ],
    STATION_EXCLUDE: ["825 NORTH CLOVIS","825 N CLOVIS","825 N. CLOVIS","825 CLOVIS"],
    TIMEOUTS: { ROUTE_LOAD: 8000, ROUTE_LIST: 5000, SCROLL_DELAY: 40, CLICK_DELAY: 0, POLL_INTERVAL: 0 },
    SCROLL: { INCREMENT: 800, MAX_ATTEMPTS: 50 },
    MAX_RECURSION_DEPTH: 15,
    MAX_LOG_ENTRIES: 100,
    DIFFICULTY: {
        FLAGGED_WEIGHT: 0.50,       // 60% from biz/apt %
        DURATION_WEIGHT: 0.40,      // 20% from route duration vs. daily average
        MULTI_TBA_WEIGHT: 0.10      // 20% from stops with multiple packages (Increased since density was removed)
    }
  };

  /* ── Utilities ────────────────────────────────────────────────────────── */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const yieldFrame = () => new Promise(r => requestAnimationFrame(r));
  const norm = s => String(s || "").toUpperCase().trim().replace(/\./g, "");

  const sanitizeCSV = s => {
    if (s == null) return "";
    const v = String(s);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };

  const formatDuration = sec => {
    if (!sec || sec <= 0) return "N/A";
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  function calcDifficulty(routeStats, dailyAvgDuration) {
    const C = CONFIG.DIFFICULTY;
    const { flaggedPct, duration, problemPoints, totalStops, totalTBAs } = routeStats;

    // 1. Flagged Stops Score
    const flaggedScore = Math.min(flaggedPct, 100) * C.FLAGGED_WEIGHT;

    // 2. Duration Score - Relative to the daily average
    let durationScore = 0;
    if (duration > 0 && dailyAvgDuration > 0) {
      const durationRatio = duration / dailyAvgDuration;
      durationScore = Math.max(0, Math.min((durationRatio - 0.8) / 0.5, 1)) * C.DURATION_WEIGHT * 100;
    }

    // 3. Multi-TBA Stops Score
    let multiTbaScore = 0;
    if (totalStops > 0 && totalTBAs > totalStops) {
        const multiTbaRatio = (totalTBAs - totalStops) / totalStops;
        multiTbaScore = Math.max(0, Math.min(multiTbaRatio / 0.5, 1)) * C.MULTI_TBA_WEIGHT * 100;
    }

    // 4. Dynamic Problem Stop Bonus
    const problemBonus = problemPoints || 0;

    // Final Score
    const finalScore = Math.round(flaggedScore + durationScore + multiTbaScore + problemBonus);
    return Math.min(finalScore, 100);
  }

  // MAX SPEED WAIT FUNCTION - Taps directly into browser render loop
  async function waitFor(pred, timeout = 5000) {
    const t0 = Date.now();
    return new Promise(resolve => {
      function check() {
        try { if (pred()) return resolve(true); } catch(e) {}
        if (Date.now() - t0 >= timeout) return resolve(false);
        requestAnimationFrame(check);
      }
      check();
    });
  }

  function checkProblem(addr) {
    const n = norm(addr);
    for (const group of CONFIG.PROBLEM_GROUPS) {
      for (const pat of group.patterns) {
        // Return points along with label and pattern
        if (n.includes(pat)) return { label: group.label, pattern: pat, points: group.points || 0 };
      }
    }
    return null;
  }

  const isStation = (addr, name) => {
    const n = norm(addr) + " " + norm(name);
    return CONFIG.STATION_EXCLUDE.some(s => n.includes(s));
  };

  function checkKeywords(addr, name, list) {
    const full = (norm(addr) + " " + norm(name)).replace(/[.,]/g, " ");
    const tok = " " + full + " ";
    for (const w of list) {
      if (w === "#") { if (/\s#\d|^#\d/.test(full)) return "#"; }
      else if (tok.includes(` ${w} `)) return w;
    }
    return null;
  }

  /* ── React fiber helpers ─────────────────────────────────────────────── */

  function getFiber(el) {
    const k = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactProps'));
    return k ? el[k] : null;
  }

  function findStopData(obj, depth = 0, seen = new WeakSet()) {
    if (depth > CONFIG.MAX_RECURSION_DEPTH || !obj || typeof obj !== 'object') return null;
    try { if (seen.has(obj)) return null; seen.add(obj); } catch(e) { return null; }

    if (obj.memoizedProps) {
      const p = obj.memoizedProps;
      for (const k of ['stop','task','data','item','delivery']) {
        const c = p[k];
        if (c && typeof c === 'object' && (c.sequenceNumber !== undefined || c.address || c.domainMap || c.taskId))
          return c;
      }
      if (p.sequenceNumber !== undefined || p.taskId || p.domainMap) return p;
    }

    for (const k of ['return','child','sibling','memoizedState','stateNode']) {
      if (obj[k] && typeof obj[k] === 'object') {
        const r = findStopData(obj[k], depth + 1, seen);
        if (r) return r;
      }
    }
    return null;
  }

  function extractRouteDuration(obj, code, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;
    try {
      if (typeof obj.routeDuration === 'number') {
        if (obj.routeCode === code || depth === 0) return obj.routeDuration;
        const s = JSON.stringify(obj).substring(0, 500);
        if (s.includes(code)) return obj.routeDuration;
      }
      if (Array.isArray(obj)) {
        for (const it of obj)
          if (it && it.routeCode === code && it.routeDuration !== undefined) return it.routeDuration;
      }
      for (const k of ['memoizedProps','memoizedState','return','child','props','data','route','routes']) {
        if (obj[k] && typeof obj[k] === 'object') {
          const d = extractRouteDuration(obj[k], code, depth + 1);
          if (d !== null) return d;
        }
      }
    } catch(e) {}
    return null;
  }

  const checkPriority = d => { try { return JSON.stringify(d).includes("PrioritizedBusinessHoursAdherence"); } catch(e) { return false; } };

  function isDelivered(stopData) {
    if (!stopData) return false;
    const search = (o, d = 0) => {
      if (d > 10 || !o || typeof o !== 'object') return false;
      const ts = String(o.taskState || "").toUpperCase();
      const es = String(o.executionStatus || "").toUpperCase();
      const tc = String(o.taskStateContext || "").toUpperCase();
      if ((ts.includes("DELIVERED") && !ts.includes("NOT_DELIVERED") && !ts.includes("ATTEMPTED")) ||
          es === "COMPLETE" || es === "COMPLETED" ||
          (tc.includes("DELIVERED") && !tc.includes("NOT_DELIVERED")) ||
          ts.includes("ATTEMPTED") || es === "ATTEMPTED" || ts.includes("BUSINESS_CLOSED"))
        return true;
      for (const v of Object.values(o)) {
        if (v && typeof v === 'object') {
          if (Array.isArray(v) ? v.some(i => search(i, d+1)) : search(v, d+1)) return true;
        }
      }
      return false;
    };
    return search(stopData);
  }

  function getAddr(d) {
    if (!d) return "";
    if (typeof d.address === 'string') return d.address;
    if (d.address && d.address.address1) return d.address.address1;
    if (d.address1) return d.address1;
    if (d.domainMap && d.domainMap.address && d.domainMap.address.address1) return d.domainMap.address.address1;
    return "";
  }
  function getName(d) {
    if (!d) return "";
    return d.customerName || d.recipientName || d.name || (d.domainMap && d.domainMap.customerName) || "";
  }
  function getSeq(d) {
    if (!d) return null;
    if (d.sequenceNumber !== undefined) return d.sequenceNumber;
    if (d.domainMap && d.domainMap.sequenceNumber !== undefined) return d.domainMap.sequenceNumber;
    var a = getAddr(d);
    return a || ('stop_' + Math.random().toString(36).slice(2,11));
  }

  function getTbaCount(d) {
    if (!d) return 1;
    if (Array.isArray(d.tasks)) return d.tasks.length;
    if (d.domainMap && Array.isArray(d.domainMap.tasks)) return d.domainMap.tasks.length;
    return 1;
  }

  function isValidDriver(t) {
    if (!t || t.length < 2 || t.length > 50) return false;
    const bad = [/^\d+h\s*\d*m/i,/left on shift/i,/stops\/hour/i,/Avg:/i,/Time left/i,
      /^\d+\/\d+/,/^\d+:\d+/,/^\d+(am|pm)$/i,/^stops$/i,/^deliveries$/i,/not available/i,/^[A-Z]{1,4}\d+$/];
    return !bad.some(p => p.test(t)) && /[a-zA-Z]/.test(t);
  }

  /* ── DOM helpers ──────────────────────────────────────────────────────── */
  const STOP_SEL = 'div[class*="stop"], div[class*="card"], div[class*="task"], div[data-index]';

  function findScroller() {
    for (const sel of [".ReactVirtualized__Grid","[data-testid='virtual-list']",".fp-page-template","main"]) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return el;
    }
    for (const div of document.querySelectorAll('div'))
      if (div.scrollHeight > window.innerHeight && div.clientHeight > 400) return div;
    return document.documentElement;
  }

  const isRouteList = () => document.querySelectorAll('p[title]').length > 0 &&
    /stops|deliveries/.test(document.body.innerText);

  function isRouteDetail() {
    for (const el of document.querySelectorAll(STOP_SEL)) {
      const f = getFiber(el);
      if (f && findStopData(f, 0, new WeakSet())) return true;
    }
    return false;
  }

  /* ── Data collection ──────────────────────────────────────────────────── */

  function getAllStops(log) {
    const stops = [], seen = new Set();
    let delivered = 0, pending = 0;
    for (const el of document.querySelectorAll(STOP_SEL)) {
      try {
        const f = getFiber(el);
        if (!f) continue;
        const sd = findStopData(f, 0, new WeakSet());
        if (!sd) continue;
        const seq = getSeq(sd);
        if (seq === null || seen.has(seq)) continue;
        seen.add(seq);
        const del = isDelivered(sd);
        del ? delivered++ : pending++;
        stops.push({ seqNum: seq, address: getAddr(sd), customerName: getName(sd),
          hasPriorityFlag: checkPriority(sd), isDelivered: del, tbaCount: getTbaCount(sd) });
      } catch (e) { console.warn('Stop error:', e); }
    }
    if (log) log(`Found ${stops.length} stops (${pending} pending, ${delivered} delivered)`, 'info');
    return stops;
  }

  async function getAllRoutes(log) {
    log('Collecting routes from list...', 'info');
    const routes = new Map(), durations = new Map();
    const scr = findScroller();
    if (scr) scr.scrollTop = 0;
    await yieldFrame();

    let sameCount = 0, prevSize = 0;
    for (let i = 0; i < CONFIG.SCROLL.MAX_ATTEMPTS; i++) {
      document.querySelectorAll('p[title]').forEach(p => {
        const tv = p.getAttribute('title') || "";
        if (!/^[A-Z]{1,4}\d+$/.test(tv)) return;
        const parent = p.closest('a.af-link') || p.closest('div[data-index]') || p.closest('div[class*="route"]');
        if (!parent) return;

        if (!durations.has(tv)) {
          const f = getFiber(parent);
          if (f) { const d = extractRouteDuration(f, tv, 0); if (d) durations.set(tv, d); }
        }

        let driver = "Unknown";
        for (const np of parent.querySelectorAll('p[title]')) {
          const t = np.getAttribute('title') || "";
          if (t !== tv && isValidDriver(t)) { driver = t; break; }
        }
        if (driver === "Unknown") {
          for (const el of parent.querySelectorAll('p, span')) {
            const t = (el.innerText || "").trim();
            if (t !== tv && isValidDriver(t) && t.includes(' ')) { driver = t; break; }
          }
        }
        if (/stops|deliveries/.test(parent.innerText || "")) routes.set(tv, driver);
      });

      if (routes.size === prevSize) { if (++sameCount > 3) break; }
      else { sameCount = 0; if (routes.size % 10 === 0) log(`Found ${routes.size} routes...`, 'info'); }
      prevSize = routes.size;
      scr ? (scr.scrollTop += CONFIG.SCROLL.INCREMENT) : window.scrollBy(0, CONFIG.SCROLL.INCREMENT);
      await sleep(CONFIG.TIMEOUTS.SCROLL_DELAY);
    }

    if (scr) scr.scrollTop = 0; else window.scrollTo(0, 0);
    log(`Total routes found: ${routes.size}`, 'success');
    log(`Duration data found for ${durations.size} routes`, 'info');
    return { routes, durations };
  }

  /* ── Main scraper ─────────────────────────────────────────────────────── */

  async function runScraper(log, shouldStop, onlyRemaining, updateProgress, updateStats) {
    const label = onlyRemaining ? "REMAINING" : "ALL";
    const { routes: routesMap, durations } = await getAllRoutes(log);
    const codes = [...routesMap.keys()];

    if (!codes.length) { log('No routes found! Make sure you are on the route list page.', 'error'); return; }

    const bizData = [], aptData = [], probData = [];
    const stats = {}, stopSets = {};
    let totalBiz = 0, totalApt = 0, totalProb = 0, priorityFlags = 0;

    for (const c of codes) {
      // Added seenProblemGroups to track which groups we've already scored
      stats[c] = {
        name: routesMap.get(c) || c,
        business: 0,
        apt: 0,
        problem: 0,
        problemPoints: 0,
        seenProblemGroups: new Set(),
        duration: durations.get(c) || 0,
        totalTBAs: 0
      };
      stopSets[c] = new Set();
    }

    log(`Scanning ${codes.length} routes (${label})...`, 'info');
    updateProgress(0, codes.length);

    for (let i = 0; i < codes.length; i++) {
      if (shouldStop()) { log('Scan stopped by user', 'warning'); break; }
      const code = codes[i], driver = routesMap.get(code);
      log(`[${i+1}/${codes.length}] ${code} (${driver})`, 'info');
      updateProgress(i, codes.length);

      const clickRoute = () => {
        for (const p of document.querySelectorAll(`p[title="${code}"]`)) {
          const lnk = p.closest('a.af-link');
          if (lnk) { lnk.click(); return true; }
        }
        return false;
      };

      // 1. INSTANT CHECK: If the UI remembered our scroll state, click immediately (0 delay).
      let found = clickRoute();

      // 2. SHORT SCROLL: If not currently rendered, we're probably right above it. Nudge down.
      if (!found) {
        const scr = findScroller();
        for (let sa = 0; sa < 5 && !found; sa++) {
          scr ? (scr.scrollTop += CONFIG.SCROLL.INCREMENT) : window.scrollBy(0, CONFIG.SCROLL.INCREMENT);
          await yieldFrame();
          found = clickRoute();
        }

        // 3. FAILSAFE: Only if completely lost do we reset to top and scan down.
        if (!found) {
          if (scr) scr.scrollTop = 0; else window.scrollTo(0, 0);
          await yieldFrame();
          for (let sa = 0; sa < 30 && !found; sa++) {
            found = clickRoute();
            if (!found) {
               scr ? (scr.scrollTop += CONFIG.SCROLL.INCREMENT) : window.scrollBy(0, CONFIG.SCROLL.INCREMENT);
               await yieldFrame();
            }
          }
        }
      }

      if (!found) { log(`Could not find route ${code}`, 'warning'); continue; }

      // Maximum speed yield. No arbitrary sleep attached.
      if (!await waitFor(isRouteDetail, CONFIG.TIMEOUTS.ROUTE_LOAD)) {
        log(`Timeout loading route ${code}`, 'warning'); window.history.back(); await yieldFrame(); continue;
      }

      if (!stats[code].duration) {
        for (const el of document.querySelectorAll('div, section, main')) {
          const f = getFiber(el);
          if (f) { const d = extractRouteDuration(f, code, 0); if (d) { stats[code].duration = d; log(`Found duration: ${formatDuration(d)}`, 'info'); break; } }
        }
      }

      for (const stop of getAllStops(log)) {
        stats[code].totalTBAs += stop.tbaCount;
        if (onlyRemaining && stop.isDelivered) continue;
        stopSets[code].add(stop.seqNum);
        if (stop.hasPriorityFlag) priorityFlags++;

        const probMatch = checkProblem(stop.address);
        if (probMatch) {
          stats[code].problem++;

          // FIX: Only add points ONCE per problem group per route to prevent massive multipliers
          if (!stats[code].seenProblemGroups.has(probMatch.label)) {
            stats[code].problemPoints += probMatch.points;
            stats[code].seenProblemGroups.add(probMatch.label);
          }

          totalProb++;
          let row = probData.find(r => r.Route === code);
          if (!row) {
            row = { Route: code, Driver: driver, ProblemStops: 0, ProblemTBAs: 0, ProblemLabels: new Set() };
            probData.push(row);
          }
          row.ProblemStops += 1;
          row.ProblemTBAs += (stop.tbaCount || 0);
          row.ProblemLabels.add(probMatch.label);
        }

        const sta = isStation(stop.address, stop.customerName);
        const bizKw = checkKeywords(stop.address, stop.customerName, CONFIG.BUSINESS_KEYWORDS);
        if ((bizKw && !sta) || (stop.hasPriorityFlag && !sta && !bizKw)) {
          stats[code].business++; totalBiz++;
          bizData.push({ Route: code, Driver: driver, Stop: stop.seqNum, Address: stop.address, Keyword: bizKw || "PriorityFlag", TBAs: stop.tbaCount });
        }

        const aptKw = checkKeywords(stop.address, stop.customerName, CONFIG.APT_KEYWORDS);
        if (aptKw) {
          stats[code].apt++; totalApt++;
          aptData.push({ Route: code, Driver: driver, Stop: stop.seqNum, Address: stop.address, Keyword: aptKw, TBAs: stop.tbaCount });
        }
      }

      const pl = stats[code].problem > 0 ? ` / ${stats[code].problem} Prob` : '';
      log(`✓ ${stats[code].business} Biz / ${stats[code].apt} Apt${pl}`, 'success');
      updateStats(totalBiz, totalApt, totalProb, i + 1);

      const back = document.querySelector('button[aria-label="Back"]');
      back ? back.click() : window.history.back();
      // Maximum speed yield to wait for route list render
      await waitFor(isRouteList, CONFIG.TIMEOUTS.ROUTE_LIST);
    }

    updateProgress(codes.length, codes.length);
    log(`Scan complete! PriorityFlags: ${priorityFlags} | Problem stops: ${totalProb}`, 'success');
    generateReport(stats, stopSets, bizData, aptData, probData, log, onlyRemaining);
  }

  /* ── Report generation ────────────────────────────────────────────────── */

  function generateReport(stats, stopSets, bizList, aptList, probList, log, onlyRemaining) {
    const keys = Object.keys(stats).sort();
    const rType = onlyRemaining ? "Remaining" : "All";
    const hdr = onlyRemaining ? "Remaining Stops" : "Total Stops";

    let tStops = 0, tBiz = 0, tApt = 0, tProb = 0, tDur = 0;
    for (const k of keys) {
      tStops += (stopSets[k] && stopSets[k].size) || 0;
      tBiz += stats[k].business; tApt += stats[k].apt; tProb += stats[k].problem; tDur += stats[k].duration || 0;
    }
    const tFlagged = tBiz + tApt;
    const tPct = tStops > 0 ? ((tFlagged / tStops) * 100).toFixed(1) : "0.0";

    const rows = [
      ['Business Stops','','','','','','','Apartment Stops','','','','','','','Problem Stops','','','','','','',
       'Route Summary','','','','','','','','','','','Team Summary','','','Problem Summary',''].join(','),
      ['Route','Driver','Stop','Address','Keyword','TBAs','','Route','Driver','Stop','Address','Keyword','TBAs','',
       'Route','Driver','Problem Flagged','Problem Stops','Problem TBAs','','',
       'Route','Driver',hdr,'Business Stops','Apt Stops','Problem Stops','Total Flagged','Flagged %','Duration','Difficulty %','',
       'Metric','Value',''].join(',')
    ];

    const teamSummary = [[hdr,tStops],['Business Stops',tBiz],['Apt Stops',tApt],
      ['Problem Stops',tProb],['Total Flagged',tFlagged],['Flagged %',`${tPct}%`],['Total Duration',formatDuration(tDur)]];

    const maxR = Math.max(bizList.length, aptList.length, probList.length, keys.length, teamSummary.length);
    const csv = s => sanitizeCSV(s);
    const empty6 = () => ['','','','','',''];

    const routesWithDuration = keys.map(k => stats[k].duration).filter(d => d > 0);
    const dailyAvgDuration = routesWithDuration.length > 0
      ? routesWithDuration.reduce((sum, d) => sum + d, 0) / routesWithDuration.length
      : 0;

    if (dailyAvgDuration > 0) {
      log(`Calculated daily average duration: ${formatDuration(dailyAvgDuration)}`, 'info');
    }

    const summaryRows = keys.map(k => {
        const s = stats[k];
        const totalStops = (stopSets[k] && stopSets[k].size) || 0;
        const flaggedStops = s.business + s.apt;
        const flaggedPct = totalStops > 0 ? (flaggedStops / totalStops) * 100 : 0;

        const routeStats = {
            flaggedPct: flaggedPct,
            duration: s.duration,
            problemStops: s.problem,
            problemPoints: s.problemPoints, // Passing dynamic points to calculator
            totalStops: totalStops,
            totalTBAs: s.totalTBAs
        };
        const difficulty = calcDifficulty(routeStats, dailyAvgDuration);

        return [
            csv(k), csv(s.name), totalStops, s.business, s.apt, s.problem,
            flaggedStops, flaggedPct.toFixed(1) + '%', formatDuration(s.duration), difficulty + '%'
        ];
    });

    for (let i = 0; i < maxR; i++) {
      const r = [];
      // Business
      if (i < bizList.length) { const b = bizList[i]; r.push(csv(b.Route),csv(b.Driver),csv(b.Stop),csv(b.Address),csv(b.Keyword),b.TBAs); }
      else r.push(...empty6());
      r.push('');
      // Apartment
      if (i < aptList.length) { const a = aptList[i]; r.push(csv(a.Route),csv(a.Driver),csv(a.Stop),csv(a.Address),csv(a.Keyword),a.TBAs); }
      else r.push(...empty6());
      r.push('');
      // Problem (per-route totals)
      if (i < probList.length) {
        const p = probList[i];
        const labels = p.ProblemLabels ? Array.from(p.ProblemLabels).sort().join('; ') : '';
        r.push(csv(p.Route), csv(p.Driver), csv(labels), p.ProblemStops, p.ProblemTBAs, '');
      } else {
        r.push(...empty6());
      }
      r.push('');
      // Route summary
      if (i < summaryRows.length) {
          r.push(...summaryRows[i]);
      } else {
          r.push('','','','','','','','','','');
      }
      r.push('');
      // Team summary
      r.push(...(i < teamSummary.length ? teamSummary[i] : ['','']));
      r.push('');
      rows.push(r.join(','));
    }

    const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `Routes_${rType}_Report_${new Date().toISOString().slice(0,10)}.csv`,
      style: 'display:none'
    });
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
    log(`${rType} report downloaded!`, 'success');
  }

  /* ── UI ────────────────────────────────────────────────────────────────── */

  function createUI() {
    const old = document.getElementById('business-scanner-panel');
    if (old) { if (old._cleanup) old._cleanup(); old.remove(); }

    if (!document.getElementById('brs-fonts')) {
      const fl = Object.assign(document.createElement('link'), { id:'brs-fonts', rel:'stylesheet',
        href:'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' });
      document.head.appendChild(fl);
    }

    const panel = document.createElement('div');
    panel.id = 'business-scanner-panel';
    panel.innerHTML = `
<style>
#business-scanner-panel{--bg:#111214;--bg2:#18191d;--bg3:#222328;--txt:#f0efe8;--txt2:#c8c8c8;--muted:#78797f;--gold:#f5c518;--border:#2a2c31;--ok:#72dda0;--warn:#f5b880;--err:#f0a0a0;position:fixed;top:16px;right:16px;width:340px;background:rgba(17,18,20,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:12px;color:var(--txt);z-index:2147483647;border:1px solid rgba(42,44,49,.65);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(245,197,24,.06);font-size:13px;overflow:hidden;animation:brsIn .2s cubic-bezier(.16,1,.3,1)}
@keyframes brsIn{from{opacity:0;transform:translateY(-10px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes brsPulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes brsShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes brsFade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.brs-header{padding:12px 14px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(180deg,rgba(24,25,29,.72),rgba(17,18,20,0));border-bottom:1px solid rgba(42,44,49,.75);cursor:grab;user-select:none}.brs-header:active{cursor:grabbing}
.brs-title{font-weight:700;font-size:15px;letter-spacing:-.02em}
.brs-header-actions{display:flex;gap:6px}
.brs-header-btn{width:28px;height:28px;border:none;background:0 0;color:var(--muted);border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.brs-header-btn:hover{background:rgba(245,197,24,.08);color:var(--txt);transform:translateY(-1px)}
.brs-header-btn.brs-close:hover{background:rgba(240,160,160,.14);color:var(--err)}
.brs-status-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:linear-gradient(135deg,rgba(245,197,24,.08),rgba(17,18,20,0));border-bottom:1px solid rgba(42,44,49,.75)}
.brs-si{width:7px;height:7px;border-radius:50%;background:var(--muted);transition:all .3s}
.brs-si.ready{background:var(--ok);box-shadow:0 0 10px rgba(114,221,160,.35)}
.brs-si.running{background:var(--gold);box-shadow:0 0 12px rgba(245,197,24,.35);animation:brsPulse 1.5s ease-in-out infinite}
.brs-si.warning{background:var(--warn);box-shadow:0 0 10px rgba(245,184,128,.35)}
.brs-si.error{background:var(--err);box-shadow:0 0 10px rgba(240,160,160,.35)}
.brs-st{flex:1;font-size:12px;font-weight:500;color:var(--txt2)}
.brs-sm{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:rgba(245,197,24,.06);color:var(--muted);border:1px solid rgba(245,197,24,.18);text-transform:uppercase;letter-spacing:.05em}
.brs-controls{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.brs-btn-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.brs-btn{position:relative;padding:10px 14px;border-radius:7px;border:none;cursor:pointer;font-family:'Inter',sans-serif;font-weight:600;font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all .15s;overflow:hidden}
.brs-btn::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.14),transparent 55%);pointer-events:none}
.brs-btn:hover:not(:disabled){transform:translateY(-1px)}.brs-btn:active:not(:disabled){transform:translateY(0)}.brs-btn:disabled{opacity:.45;cursor:not-allowed}
.brs-bp{color:#111214;background:linear-gradient(135deg,var(--gold),#d6aa10);box-shadow:0 6px 18px rgba(245,197,24,.22)}
.brs-bp:hover:not(:disabled){box-shadow:0 8px 24px rgba(245,197,24,.28)}
.brs-bs{color:var(--txt);background:linear-gradient(135deg,#1b1c20,#141518);border:1px solid rgba(245,197,24,.22);box-shadow:0 6px 18px rgba(0,0,0,.35)}
.brs-bs:hover:not(:disabled){background:linear-gradient(135deg,#202127,#16171b)}
.brs-stop-btn{flex:1;padding:8px 12px;background:rgba(24,25,29,.55);border:1px solid var(--border);border-radius:7px;color:var(--txt2);font-family:'Inter',sans-serif;font-weight:600;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:all .15s}
.brs-stop-btn:hover:not(:disabled){background:rgba(240,160,160,.1);border-color:rgba(240,160,160,.4);color:var(--err);transform:translateY(-1px)}
.brs-stop-btn:disabled{opacity:.35;cursor:not-allowed}
.brs-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px 14px 12px}
.brs-stat{background:rgba(24,25,29,.45);border:1px solid rgba(42,44,49,.85);border-radius:8px;padding:10px 6px;text-align:center;transition:all .15s}
.brs-stat:hover{background:rgba(24,25,29,.62);border-color:rgba(245,197,24,.22);transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,.35)}
.brs-sv{font-size:18px;font-weight:700;line-height:1}
.brs-stat.business .brs-sv{color:var(--gold)}.brs-stat.apartment .brs-sv{color:var(--warn)}.brs-stat.problem .brs-sv{color:var(--err)}.brs-stat.routes .brs-sv{color:var(--ok)}
.brs-sl{font-size:9px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-top:5px}
.brs-ps{padding:0 14px 12px}
.brs-ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.brs-pl,.brs-lt{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.brs-pv{font-size:10px;font-weight:600;color:var(--gold)}
.brs-pt{height:5px;background:rgba(245,197,24,.06);border-radius:999px;overflow:hidden;border:1px solid rgba(245,197,24,.18)}
.brs-pf{height:100%;background:linear-gradient(90deg,var(--gold),#d6aa10);border-radius:999px;width:0%;transition:width .3s;box-shadow:0 0 14px rgba(245,197,24,.35)}
.brs-pf.active::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.26),transparent);animation:brsShimmer 1.5s ease-in-out infinite}
.brs-ls{padding:12px 14px 14px;border-top:1px solid rgba(42,44,49,.75)}
.brs-lh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.brs-lc{font-size:10px;font-weight:600;padding:3px 8px;background:rgba(245,197,24,.06);border:1px solid rgba(245,197,24,.18);border-radius:5px;color:var(--muted);cursor:pointer;transition:all .15s}
.brs-lc:hover{border-color:rgba(245,197,24,.28);color:var(--txt2);background:rgba(245,197,24,.1);transform:translateY(-1px)}
.brs-log{background:rgba(0,0,0,.28);border:1px solid rgba(42,44,49,.85);border-radius:8px;height:100px;overflow-y:auto;font-size:11px;scrollbar-width:thin;scrollbar-color:rgba(245,197,24,.18) transparent}
.brs-log::-webkit-scrollbar{width:5px}.brs-log::-webkit-scrollbar-track{background:0 0}.brs-log::-webkit-scrollbar-thumb{background:rgba(245,197,24,.18);border-radius:999px}
.brs-le{padding:6px 10px;display:flex;gap:8px;border-bottom:1px solid rgba(42,44,49,.75);animation:brsFade .2s ease}.brs-le:last-child{border-bottom:none}
.brs-lt2{color:var(--muted);font-weight:500;min-width:58px;flex-shrink:0;font-size:10px}
.brs-lm{flex:1;word-break:break-word;line-height:1.35;color:var(--txt2)}
.brs-lm.success{color:var(--ok)}.brs-lm.warning{color:var(--warn)}.brs-lm.error{color:var(--err)}
#business-scanner-panel.minimized .brs-status-bar,#business-scanner-panel.minimized .brs-controls,#business-scanner-panel.minimized .brs-stats,#business-scanner-panel.minimized .brs-ps,#business-scanner-panel.minimized .brs-ls{display:none}
#business-scanner-panel.minimized{width:auto}#business-scanner-panel.minimized .brs-header{border-bottom:none}
@media(max-height:700px){.brs-log{height:70px}}
</style>
<div class="brs-header" id="brs-drag">
  <div class="brs-title">Route Scanner</div>
  <div class="brs-header-actions">
    <button class="brs-header-btn" id="brs-min" title="Minimize"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    <button class="brs-header-btn brs-close" id="brs-close" title="Close"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
  </div>
</div>
<div class="brs-status-bar">
  <div class="brs-si ready" id="brs-dot"></div>
  <span class="brs-st" id="brs-stxt">Ready to scan</span>
  <span class="brs-sm" id="brs-mode">Standby</span>
</div>
<div class="brs-controls">
  <div class="brs-btn-row">
    <button id="brs-scan-all" class="brs-btn brs-bp"><span>⚡</span><span>Scan All</span></button>
    <button id="brs-scan-rem" class="brs-btn brs-bs"><span>🔍</span><span>Remaining</span></button>
  </div>
  <div style="display:flex;gap:8px">
    <button id="brs-stop" class="brs-stop-btn" disabled><span>◼</span><span>Stop Scan</span></button>
  </div>
</div>
<div class="brs-stats">
  <div class="brs-stat business"><div class="brs-sv" id="s-biz">0</div><div class="brs-sl">Business</div></div>
  <div class="brs-stat apartment"><div class="brs-sv" id="s-apt">0</div><div class="brs-sl">Apartment</div></div>
  <div class="brs-stat problem"><div class="brs-sv" id="s-prob">0</div><div class="brs-sl">Problem</div></div>
  <div class="brs-stat routes"><div class="brs-sv" id="s-rte">0</div><div class="brs-sl">Routes</div></div>
</div>
<div class="brs-ps" id="brs-psec" style="display:none">
  <div class="brs-ph"><span class="brs-pl">Progress</span><span class="brs-pv" id="brs-ptxt">0 / 0</span></div>
  <div class="brs-pt"><div class="brs-pf" id="brs-pfill"></div></div>
</div>
<div class="brs-ls">
  <div class="brs-lh"><span class="brs-lt">Activity Log</span><button class="brs-lc" id="brs-lclear">Clear</button></div>
  <div class="brs-log" id="brs-log"></div>
</div>`;

    document.body.appendChild(panel);
    const $ = id => document.getElementById(id);

    const scanAll = $('brs-scan-all'), scanRem = $('brs-scan-rem'), stopBtn = $('brs-stop');
    const logEl = $('brs-log'), dot = $('brs-dot'), stxt = $('brs-stxt'), mode = $('brs-mode');
    const psec = $('brs-psec'), pfill = $('brs-pfill'), ptxt = $('brs-ptxt');

    const setStatus = (s, t, m) => { dot.className = 'brs-si ' + s; stxt.textContent = t; mode.textContent = m; };

    const addLog = (msg, type = 'info') => {
      const d = document.createElement('div'); d.className = 'brs-le';
      const ts = new Date().toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
      d.innerHTML = `<span class="brs-lt2">${ts}</span><span class="brs-lm ${type}">${msg}</span>`;
      logEl.firstChild ? logEl.insertBefore(d, logEl.firstChild) : logEl.appendChild(d);
      while (logEl.children.length > CONFIG.MAX_LOG_ENTRIES) logEl.removeChild(logEl.lastChild);
    };

    const updateStats = (b, a, p, r) => { $('s-biz').textContent=b; $('s-apt').textContent=a; $('s-prob').textContent=p; $('s-rte').textContent=r; };

    const setProgress = (cur, tot) => {
      if (tot > 0) { psec.style.display='block'; const p=Math.round((cur/tot)*100); pfill.style.width=p+'%'; pfill.classList.add('active'); ptxt.textContent=`${cur} / ${tot}`; }
      else { psec.style.display='none'; pfill.classList.remove('active'); }
    };

    $('brs-lclear').onclick = () => { logEl.innerHTML = ''; addLog('Log cleared'); };
    addLog('Scanner initialized v' + CONFIG.VERSION, 'success');
    var totalPatterns = CONFIG.PROBLEM_GROUPS.reduce((sum, group) => sum + group.patterns.length, 0);
    addLog('Tracking ' + totalPatterns + ' problem addresses in ' + CONFIG.PROBLEM_GROUPS.length + ' groups');

    let running = false;
    const state = { stopRequested: false };

    async function startScan(remaining) {
      if (running) return;
      running = true; state.stopRequested = false;
      scanAll.disabled = scanRem.disabled = true; stopBtn.disabled = false;
      setStatus('running', 'Scanning in progress...', remaining ? 'Remaining' : 'Full Scan');
      addLog(remaining ? 'Starting remaining stops scan...' : 'Starting full route scan...');
      updateStats(0,0,0,0);
      try {
        await runScraper(addLog, () => state.stopRequested, remaining, setProgress, updateStats);
      } catch (e) {
        addLog(`Error: ${e.message}`, 'error'); console.error('Scanner error:', e); setStatus('error','Scan failed','Error');
      } finally {
        running = false;
        scanAll.disabled = scanRem.disabled = false;
        stopBtn.disabled = true;
        setProgress(0,0);
        if (!state.stopRequested) {
            setStatus('ready', 'Scan complete', 'Standby');
        } else {
            setStatus('ready', 'Scan stopped', 'Standby');
        }
      }
    }

    scanAll.onclick = () => startScan(false);
    scanRem.onclick = () => startScan(true);
    stopBtn.onclick = () => {
      state.stopRequested = true;
      stopBtn.disabled = true;
      setStatus('warning','Stopping scan...','Stopping');
      addLog('Stop requested by user','warning');
    };

    $('brs-min').onclick = e => {
      e.stopPropagation();
      panel.classList.toggle('minimized');
      const m = panel.classList.contains('minimized');
      $('brs-min').innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10${m?'M8 3v10':''}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      $('brs-min').title = m ? 'Expand' : 'Minimize';
    };

    $('brs-close').onclick = () => {
      panel.style.animation = 'brsIn .2s ease reverse';
      setTimeout(() => { if (panel._cleanup) panel._cleanup(); panel.remove(); }, 200);
    };

    // Drag
    let dragging = false, dx = 0, dy = 0, sx = 0, sy = 0;
    $('brs-drag').onmousedown = e => {
      if (e.target.closest('.brs-header-btn')) return;
      dragging = true; dx = e.clientX; dy = e.clientY;
      const r = panel.getBoundingClientRect(); sx = r.left; sy = r.top;
      panel.style.right = 'auto'; panel.style.left = sx+'px'; panel.style.top = sy+'px'; e.preventDefault();
    };
    const onMove = e => {
        if (!dragging) return;
        panel.style.left = Math.max(0,Math.min(innerWidth-panel.offsetWidth,sx+e.clientX-dx))+'px';
        panel.style.top = Math.max(0,Math.min(innerHeight-panel.offsetHeight,sy+e.clientY-dy))+'px';
    };
    const onUp = () => dragging = false;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    panel._cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
  }

  setTimeout(createUI, 800);
})();
