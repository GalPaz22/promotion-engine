/**
 * Promotion Engine Widget  —  widget.js
 *
 * Embed (recommended — async safe):
 *
 *   <script>
 *     window.PromoSettings = {
 *       apiKey: "YOUR_KEY",
 *       server: "https://promotion-engine-nnsk.onrender.com"  // optional
 *     };
 *   </script>
 *   <script src="https://promotion-engine-nnsk.onrender.com/widget.js" async></script>
 *
 * Config is fetched from the server and cached in localStorage (5-min TTL,
 * stale-while-revalidate) — no other attributes needed.
 *
 * Programmatic API (window.PromoWidget):
 *   .open()       — open the side panel
 *   .close()      — close the side panel
 *   .reload()     — re-fetch promotions
 *   .sessionId()  — returns the current session ID
 */
(function () {
  'use strict';

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  // Priority order:
  //   1. window.PromoSettings  — recommended for async/defer loading
  //   2. data-* attributes     — fallback for synchronous inline script tags
  //
  // Recommended usage (async-safe, matches industry loader pattern):
  //   <script>
  //     window.PromoSettings = {
  //       apiKey: "YOUR_KEY",
  //       server: "https://promotion-engine-nnsk.onrender.com"  // optional
  //     };
  //   </script>
  //   <script src=".../widget.js" async></script>

  const _settings  = window.PromoSettings || {};

  // data-* fallback — only reliable on synchronous (non-async) script tags
  const scriptEl   = document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();
  const _dataset   = scriptEl ? scriptEl.dataset : {};

  const API_KEY    = _settings.apiKey  || _dataset.apiKey  || '';
  const API_SERVER = (_settings.server || _dataset.server  || 'https://promotion-engine-nnsk.onrender.com').replace(/\/$/, '');

  if (!API_KEY) {
    console.warn('[PromoWidget] apiKey is required — widget disabled. Set window.PromoSettings.apiKey or data-api-key.');
    return;
  }
  if (window.__pe_loaded) return;
  window.__pe_loaded = true;

  // ─── Logger ───────────────────────────────────────────────────────────────
  // All widget output is prefixed and grouped so it's easy to spot in DevTools.
  const LOG_PREFIX = '%c[PromoWidget]%c';
  const LOG_STYLE  = 'color:#e8e8e8;background:#e8003d;font-weight:700;padding:1px 4px;border-radius:3px';
  const LOG_RESET  = 'color:inherit';

  const log = {
    info:  (...a) => console.log(LOG_PREFIX, LOG_STYLE, LOG_RESET, ...a),
    warn:  (...a) => console.warn(LOG_PREFIX, LOG_STYLE, LOG_RESET, ...a),
    error: (...a) => console.error(LOG_PREFIX, LOG_STYLE, LOG_RESET, ...a),
    group: (label) => console.groupCollapsed(LOG_PREFIX + ' ' + label, LOG_STYLE, LOG_RESET),
    end:   () => console.groupEnd(),
  };

  // ─── Config (filled after fetch, safe defaults while loading) ────────────
  const cfg = {
    server:           API_SERVER || 'https://promotion-engine-nnsk.onrender.com',
    limit:            20,
    lang:             'he',
    platform:         'unknown',
    atcPatterns:      [],
    checkoutPatterns: [],
    productIdField:   'id',
    quantityField:    'quantity',
    atcSelector:      '',
  };

  // Cache key is scoped to the API key so switching environments never
  // serves a stale localhost config to a production page.
  const CFG_CACHE_KEY = 'pe_cfg_v1_' + API_KEY.slice(0, 12);
  const CFG_CACHE_TTL = 5 * 60 * 1000; // 5 min

  function readCfgCache() {
    try {
      const raw = localStorage.getItem(CFG_CACHE_KEY);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > CFG_CACHE_TTL) { localStorage.removeItem(CFG_CACHE_KEY); return null; }
      return data || null;
    } catch { return null; }
  }

  function writeCfgCache(data) {
    try { localStorage.setItem(CFG_CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch {}
  }

  function applyCfg(data) {
    if (!data) return;
    if (data.server)           cfg.server           = data.server.replace(/\/$/, '');
    if (data.limit)            cfg.limit            = data.limit;
    if (data.lang)             cfg.lang             = data.lang;
    if (data.platform)         cfg.platform         = data.platform;
    if (data.atcPatterns)      cfg.atcPatterns      = data.atcPatterns;
    if (data.checkoutPatterns) cfg.checkoutPatterns = data.checkoutPatterns;
    if (data.productIdField)   cfg.productIdField   = data.productIdField;
    if (data.quantityField)    cfg.quantityField    = data.quantityField;
    if (data.atcSelector)      cfg.atcSelector      = data.atcSelector;

    log.group('Config applied');
    log.info('platform:', cfg.platform, '| lang:', cfg.lang, '| limit:', cfg.limit);
    log.info('ATC patterns:', cfg.atcPatterns.length ? cfg.atcPatterns : '(platform defaults)');
    log.info('ATC selector:', cfg.atcSelector || '(none)');
    log.end();
  }

  function fetchCfg(onDone) {
    log.info('Fetching config from server…', cfg.server);
    const t0 = Date.now();
    fetch(`${cfg.server}/widget/config`, {
      headers: { 'x-api-key': API_KEY },
    })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(data => {
        log.info(`Config received in ${Date.now() - t0}ms`, data);
        writeCfgCache(data);
        onDone(data);
      })
      .catch(err => {
        log.warn('Config fetch failed — running with defaults:', err);
        onDone(null);
      });
  }

  // ─── Session management ───────────────────────────────────────────────────
  function ensureSessionId() {
    try {
      // Reuse the existing Semantix session if present — keeps all tracking
      // on a single session ID across both engines.
      const sid =
        localStorage.getItem('semantix_session_id') ||
        localStorage.getItem('pe_session_id') ||
        (() => {
          const s = 'pe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
          localStorage.setItem('pe_session_id', s);
          return s;
        })();
      return sid;
    } catch {
      if (!ensureSessionId._mem)
        ensureSessionId._mem = 'pe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      return ensureSessionId._mem;
    }
  }

  // ─── i18n ─────────────────────────────────────────────────────────────────
  const T = {
    he: { cta: 'לחץ כאן לעוד מבצעים מותאמים לך', panelTitle: 'מבצעים מותאמים לך', products: 'מוצרים', personalized: '✦ מותאם אישית', onSale: 'On Sale', profile: 'Profile' },
    en: { cta: 'See all personalized deals', panelTitle: 'Your Personalized Deals', products: 'products', personalized: '✦ Personalized', onSale: 'On Sale', profile: 'Profile' },
  };
  const t = T[cfg.lang] || T.he;

  // ─── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
    :root {
      --pe-card:   rgba(255, 252, 247, 0.82);   /* frosted warm white */
      --pe-panel:  rgba(252, 248, 242, 0.96);
      --pe-line:   rgba(160, 120, 60, 0.12);
      --pe-ink:    #1c1510;                      /* dark text */
      --pe-muted:  rgba(28, 21, 16, 0.42);
      --pe-accent: #3d2e1e;
      --pe-sale:   #d63b24;
      --pe-gold:   #a07832;
      --pe-ease:   cubic-bezier(0.25,0.46,0.45,0.94);
      --pe-drawer-w: 380px;
      --pe-panel-w:  400px;
      --pe-border-r: 16px;
    }

    /* ── Shimmer border ── */
    @property --pe-angle {
      syntax: '<angle>';
      inherits: false;
      initial-value: 0deg;
    }
    @keyframes pe-border-spin {
      from { --pe-angle: 0deg; }
      to   { --pe-angle: 360deg; }
    }

    /* ── Card wrapper — the spinning gradient border lives here ── */
    #pe-card-wrap {
      position: fixed;
      bottom: calc(28px + env(safe-area-inset-bottom, 0px));
      left: 24px;
      width: var(--pe-drawer-w);
      border-radius: calc(var(--pe-border-r) + 3px);
      z-index: 2147483640;
      padding: 3px;                        /* border thickness */
      /* Base layer: subtle static glow so border is visible even when slow */
      background:
        conic-gradient(
          from var(--pe-angle),
          rgba(180,140,80,0.10) 0deg,
          rgba(180,140,80,0.10) 40deg,
          rgba(255,220,140,1)   90deg,    /* warm gold comet head */
          rgba(220,180,110,0.7) 120deg,   /* gold tail */
          rgba(200,160,90,0.18) 165deg,   /* dim tail */
          rgba(180,140,80,0.10) 210deg,
          rgba(180,140,80,0.10) 360deg
        );
      /* Warm gold outer glow */
      filter: drop-shadow(0 0 7px rgba(210,165,80,0.45));
      animation: pe-border-spin 2.6s linear infinite paused;
      transform: translateY(calc(100% + 80px));
      visibility: hidden;
      transition: transform 0.55s var(--pe-ease), visibility 0s 0.55s;
      will-change: transform;
    }
    #pe-card-wrap.pe-open {
      transform: translateY(0);
      visibility: visible;
      transition: transform 0.55s var(--pe-ease), visibility 0s 0s;
      animation-play-state: running;
    }

    /* ── Card ── */
    #pe-card {
      width: 100%;
      border-radius: var(--pe-border-r);
      overflow: hidden;
      background: var(--pe-card);
      backdrop-filter: blur(24px) saturate(1.6);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      box-shadow:
        0 8px 32px rgba(80, 50, 20, 0.18),
        0 2px 8px  rgba(80, 50, 20, 0.10),
        inset 0 1px 0 rgba(255,255,255,0.7);   /* top highlight */
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      display: flex;
      flex-direction: column;
    }

    .pe-card-main {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      position: relative;
      height: 116px;       /* fixed height — images never stretch the card */
    }

    /* image column */
    .pe-img-wrap {
      position: relative;
      width: 100px;
      height: 100%;        /* fills the fixed-height row */
      flex-shrink: 0;
      overflow: hidden;
      background: rgba(245, 238, 225, 0.6);
    }
    .pe-img {
      width: 100%; height: 100%;
      object-fit: contain;
      object-position: center;
      padding: 6px;
      box-sizing: border-box;
      display: block;
      transition: transform 6s ease;
    }
    #pe-card-wrap:hover .pe-img { transform: scale(1.06); }
    .pe-img-ph {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 32px;
      background: rgba(230, 218, 198, 0.5);
    }
    .pe-img-fade {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 36px;
      background: linear-gradient(to right, transparent, rgba(255,252,247,0.82));
      pointer-events: none;
    }
    .pe-sale-pill {
      position: absolute;
      top: 8px; left: 8px;
      background: var(--pe-sale);
      color: #fff;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 20px;
      font-family: inherit;
    }

    /* close button */
    .pe-close {
      position: absolute;
      top: 8px; right: 8px;
      width: 22px; height: 22px;
      border-radius: 50%;
      background: rgba(28, 21, 16, 0.12);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(28,21,16,0.12);
      color: rgba(28, 21, 16, 0.55);
      font-size: 11px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      z-index: 2;
      line-height: 1;
      transition: background 0.15s, color 0.15s;
      font-family: inherit;
      padding: 0;
    }
    .pe-close:hover { background: rgba(28,21,16,0.2); color: var(--pe-ink); }

    /* content column */
    .pe-body {
      flex: 1;
      min-width: 0;
      padding: 14px 14px 14px 12px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
    }
    .pe-cat {
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: 1.6px;
      text-transform: uppercase;
      color: var(--pe-gold);
    }
    .pe-name {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--pe-ink);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .pe-price-row { display: flex; flex-direction: column; gap: 1px; margin-top: 2px; }
    .pe-price-main { display: flex; align-items: baseline; gap: 6px; }
    .pe-price {
      font-size: 15px;
      font-weight: 700;
      color: var(--pe-ink);
      letter-spacing: -0.5px;
    }
    .pe-promo-tag { font-size: 9.5px; color: var(--pe-sale); font-weight: 600; }
    .pe-orig-price {
      font-size: 10px;
      font-weight: 400;
      color: rgba(28,21,16,0.38);
      text-decoration: line-through;
    }
    .pe-orig-price::before {
      content: 'היה ';
      text-decoration: none;
      color: rgba(28,21,16,0.28);
    }

    /* CTA strip */
    .pe-divider { height: 1px; background: var(--pe-line); }
    .pe-cta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .pe-cta:hover  { background: rgba(28,21,16,0.04); }
    .pe-cta:active { background: rgba(28,21,16,0.08); }
    .pe-cta-text {
      font-size: 11px;
      font-weight: 500;
      color: var(--pe-accent);
      direction: rtl;
      text-align: right;
      line-height: 1.4;
    }
    .pe-cta-arrow {
      font-size: 14px;
      color: var(--pe-muted);
      transition: transform 0.2s, color 0.2s;
      flex-shrink: 0;
    }
    .pe-cta:hover .pe-cta-arrow { transform: translateX(3px); color: var(--pe-ink); }

    /* ── Side panel overlay ── */
    #pe-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483641;
      background: rgba(20,12,5,0.35);
      backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
    }
    #pe-overlay.pe-open { opacity: 1; pointer-events: all; }

    #pe-panel {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: var(--pe-panel-w);
      background: var(--pe-panel);
      backdrop-filter: blur(28px) saturate(1.5);
      -webkit-backdrop-filter: blur(28px) saturate(1.5);
      border-right: 1px solid rgba(160,120,60,0.15);
      display: flex;
      flex-direction: column;
      transform: translateX(-100%);
      transition: transform 0.45s var(--pe-ease);
      overflow: hidden;
    }
    #pe-overlay.pe-open #pe-panel { transform: translateX(0); }

    .pe-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 20px 16px;
      border-bottom: 1px solid var(--pe-line);
      flex-shrink: 0;
    }
    .pe-panel-header-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .pe-panel-title { font-size: 14px; font-weight: 600; color: var(--pe-ink); }
    .pe-panel-count {
      font-size: 11px; color: var(--pe-muted);
      background: rgba(28,21,16,0.06);
      border: 1px solid var(--pe-line);
      border-radius: 20px; padding: 2px 9px;
    }
    .pe-panel-pers {
      font-size: 10px; color: var(--pe-sale);
      background: rgba(214,59,36,0.08);
      border: 1px solid rgba(214,59,36,0.2);
      border-radius: 20px; padding: 2px 9px; font-weight: 500;
    }
    .pe-panel-close {
      width: 28px; height: 28px; border-radius: 50%;
      background: rgba(28,21,16,0.06);
      border: 1px solid var(--pe-line);
      color: var(--pe-muted);
      font-size: 14px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; padding: 0;
      transition: background 0.15s, color 0.15s;
      font-family: inherit;
    }
    .pe-panel-close:hover { background: rgba(255,255,255,0.12); color: var(--pe-white); }

    .pe-panel-body { overflow-y: auto; padding: 18px 16px 28px; flex: 1; }
    .pe-panel-body::-webkit-scrollbar { width: 3px; }
    .pe-panel-body::-webkit-scrollbar-track { background: transparent; }
    .pe-panel-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    .pe-affinities {
      display: flex; align-items: center;
      gap: 6px; margin-bottom: 16px; flex-wrap: wrap;
    }
    .pe-aff-label { font-size: 10px; color: var(--pe-muted); letter-spacing: 0.8px; text-transform: uppercase; }
    .pe-aff-pill {
      font-size: 10px; background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; padding: 2px 9px; color: var(--pe-accent);
    }

    /* product list */
    .pe-grid { display: flex; flex-direction: column; gap: 10px; }

    .pe-item {
      background: #181818;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px; overflow: hidden;
      cursor: pointer; display: flex; flex-direction: row; align-items: stretch;
      transition: background 0.18s, border-color 0.18s;
      text-decoration: none;
    }
    .pe-item:hover { background: #1e1e1e; border-color: rgba(255,255,255,0.13); }

    .pe-item-img-wrap {
      position: relative; width: 70px; flex-shrink: 0;
      overflow: hidden; background: #0a0a0a;
    }
    .pe-item-img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.4s var(--pe-ease); }
    .pe-item:hover .pe-item-img { transform: scale(1.06); }
    .pe-item-img-ph {
      width: 100%; min-height: 72px; height: 100%;
      display: flex; align-items: center; justify-content: center; font-size: 28px;
    }
    .pe-item-dot {
      position: absolute; top: 6px; right: 6px;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--pe-sale); box-shadow: 0 0 6px rgba(255,59,48,0.7);
    }

    .pe-item-body {
      flex: 1; min-width: 0; padding: 10px 12px;
      display: flex; flex-direction: column; justify-content: center; gap: 2px;
    }
    .pe-item-cat { font-size: 8px; font-weight: 500; letter-spacing: 1.4px; text-transform: uppercase; color: var(--pe-muted); }
    .pe-item-name {
      font-size: 12px; font-weight: 500; color: var(--pe-white); line-height: 1.3;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .pe-item-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
    .pe-item-price { font-size: 13px; font-weight: 700; color: var(--pe-white); }
    .pe-item-orig  { font-size: 10px; font-weight: 400; color: rgba(255,255,255,0.4); text-decoration: line-through; margin-left: 5px; }
    .pe-item-link  { font-size: 12px; color: var(--pe-muted); text-decoration: none; transition: color 0.15s; }
    .pe-item-link:hover { color: var(--pe-white); }

    /* ── Responsive ── */
    @media (max-width: 768px) {
      :root { --pe-drawer-w: calc(100vw - 32px); --pe-panel-w: 100vw; }
      #pe-card-wrap { left: 16px; right: 16px; bottom: calc(88px + env(safe-area-inset-bottom, 0px)); width: auto; }
      .pe-img-wrap { width: 88px; }
      #pe-panel { border-right: none; }
    }
    @media (max-width: 480px) {
      #pe-card-wrap { left: 12px; right: 12px; bottom: calc(96px + env(safe-area-inset-bottom, 0px)); }
      .pe-img-wrap { width: 76px; }
      .pe-name  { font-size: 11px; }
      .pe-price { font-size: 13px; }
      .pe-body  { padding: 10px 10px 10px 8px; }
      .pe-cta   { padding: 9px 12px; }
      .pe-cta-text { font-size: 10px; }
    }
  `;

  // ─── HTML ─────────────────────────────────────────────────────────────────
  const HTML = `
    <!-- product card -->
    <div id="pe-card-wrap">
      <div id="pe-card">
      <button class="pe-close" id="pe-close-btn">✕</button>
      <div class="pe-card-main">
        <div class="pe-img-wrap">
          <img class="pe-img" id="pe-img" src="" alt="" style="display:none" />
          <div class="pe-img-ph" id="pe-img-ph">🏷️</div>
          <div class="pe-img-fade"></div>
          <span class="pe-sale-pill">${t.onSale}</span>
        </div>
        <div class="pe-body">
          <div class="pe-cat"  id="pe-cat"></div>
          <div class="pe-name" id="pe-name">—</div>
          <div class="pe-price-row">
            <div class="pe-price-main">
              <span class="pe-price" id="pe-price">—</span>
              <span class="pe-promo-tag" id="pe-promo-tag"></span>
            </div>
            <span class="pe-orig-price" id="pe-orig-price" style="display:none"></span>
          </div>
        </div>
      </div>
      <div class="pe-divider"></div>
      <div class="pe-cta" id="pe-cta">
        <span class="pe-cta-arrow">›</span>
        <span class="pe-cta-text">${t.cta}</span>
      </div>
      </div>
    </div>

    <!-- side panel -->
    <div id="pe-overlay">
      <div id="pe-panel">
        <div class="pe-panel-header">
          <div class="pe-panel-header-left">
            <span class="pe-panel-title">${t.panelTitle}</span>
            <span class="pe-panel-count" id="pe-panel-count"></span>
            <span class="pe-panel-pers"  id="pe-panel-pers" style="display:none">${t.personalized}</span>
          </div>
          <button class="pe-panel-close" id="pe-panel-close">✕</button>
        </div>
        <div class="pe-panel-body">
          <div class="pe-affinities" id="pe-affinities" style="display:none">
            <span class="pe-aff-label">${t.profile}</span>
          </div>
          <div class="pe-grid" id="pe-grid"></div>
        </div>
      </div>
    </div>
  `;

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(p) {
    const n = parseFloat(p);
    return isNaN(n) ? '—' : `₪${n.toFixed(2)}`;
  }
  function firstCat(c) { return [].concat(c || []).filter(Boolean)[0] || ''; }
  function promoLabel(promos) {
    const p = [].concat(promos || [])[0];
    if (!p) return '';
    return typeof p === 'string' ? p : (p.title || p.name || p.description || '');
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let _products = [];

  // ─── Event tracking ───────────────────────────────────────────────────────
  function trackEvent(type, product) {
    if (!product) return;
    const payload = {
      session_id:   ensureSessionId(),
      event_type:   type,                          // 'view' | 'click' | 'cart'
      product_id:   String(product.id || product._id || ''),
      product_name: product.name || '',
      category:     product.category  || [],
      softCategory: product.softCategory || [],
    };
    log.info(`Event: ${type.toUpperCase()} »`, product.name || payload.product_id);
    // fire-and-forget; use sendBeacon if available so it survives navigation
    const url  = `${cfg.server}/pe/signal`;
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }

  // ─── Cart intercept ───────────────────────────────────────────────────────
  // Wraps fetch + XHR to detect add-to-cart requests and fire a 'cart' event.
  function attachCartIntercept() {
    if (window.__pe_cart_intercept) return;
    window.__pe_cart_intercept = true;
    log.info('Cart intercept active — platform:', cfg.platform,
      '| patterns:', cfg.atcPatterns.length ? cfg.atcPatterns : '(platform defaults)',
      cfg.atcSelector ? `| DOM selector: ${cfg.atcSelector}` : '');

    // Platform-level fallback patterns (used when store config has none)
    const PLATFORM_PATTERNS = {
      shopify:     ['/cart/add', '/cart/add.js', '/cart/add.json'],
      woocommerce: ['wc-ajax=add_to_cart', '?add-to-cart='],
      magento:     ['/checkout/cart/add'],
      bigcommerce: ['/remote/v1/cart/add'],
      prestashop:  ['controller=cart', 'add=1'],
    };

    function isAtcUrl(url) {
      const u = (url || '').toLowerCase();
      // Store-specific patterns from siteConfig take priority
      const storePats = cfg.atcPatterns || [];
      if (storePats.length) return storePats.some(p => u.includes(p));
      // Fall back to known platform patterns
      const platformPats = PLATFORM_PATTERNS[cfg.platform] || [];
      return platformPats.some(p => u.includes(p));
    }

    function extractProductId(body) {
      if (!body) return null;
      // Primary field comes from siteConfig.clickTracking.cartInterceptor.productIdField
      const FIELDS = [cfg.productIdField, 'id', 'product_id', 'add-to-cart', 'items[0][id]']
        .filter((v, i, a) => v && a.indexOf(v) === i);
      try {
        if (typeof body === 'string') {
          try {
            const j = JSON.parse(body);
            for (const f of FIELDS) if (j[f]) return String(j[f]);
            if (Array.isArray(j.items) && j.items[0]) {
              for (const f of FIELDS) if (j.items[0][f]) return String(j.items[0][f]);
            }
          } catch {}
          const p = new URLSearchParams(body);
          for (const f of FIELDS) { const v = p.get(f); if (v) return v; }
        }
        if (body instanceof FormData) {
          for (const f of FIELDS) { const v = body.get(f); if (v) return String(v); }
        }
        if (body instanceof URLSearchParams) {
          for (const f of FIELDS) { const v = body.get(f); if (v) return String(v); }
        }
      } catch {}
      return null;
    }

    function onCart(productId) {
      // Look up the product in our loaded list for category/softCategory context
      const product = _products.find(p => String(p.id || p._id) === String(productId)) || { id: productId };
      log.info('Cart intercept fired — product ID:', productId, product.name ? `(${product.name})` : '');
      trackEvent('cart', product);
    }

    // Wrap fetch
    const _origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (isAtcUrl(url)) {
          const pid = extractProductId(init?.body);
          if (pid) onCart(pid);
        }
      } catch {}
      return _origFetch.apply(this, arguments);
    };

    // Wrap XHR
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__pe_url = url;
      return _origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (isAtcUrl(this.__pe_url || '')) {
          const pid = extractProductId(body);
          if (pid) onCart(pid);
        }
      } catch {}
      return _origSend.apply(this, arguments);
    };

    // DOM click intercept via siteConfig.clickTracking.addToCartSelector
    // Runs once after config is applied (re-called on applyCfg if selector changes)
    function attachAtcClickListener() {
      const sel = cfg.atcSelector;
      if (!sel) return;
      document.addEventListener('click', function (e) {
        try {
          const btn = e.target.closest(sel);
          if (!btn) return;
          // Try to read product id from data attributes on the button or its closest card
          const card = btn.closest('[data-id],[data-semantix-pid],[data-pid]');
          const pid  = card
            ? (card.dataset.semantixPid || card.dataset.pid || card.dataset.id)
            : (btn.dataset.productId || btn.dataset.id || null);
          onCart(pid || '__unknown__');
        } catch {}
      }, true);
    }

    attachAtcClickListener();
  }

  // ─── Mount ────────────────────────────────────────────────────────────────
  function mount() {
    // inject CSS
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // inject HTML
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);

    // wire events
    document.getElementById('pe-close-btn').addEventListener('click', dismiss);
    document.getElementById('pe-cta').addEventListener('click', openPanel);
    document.getElementById('pe-panel-close').addEventListener('click', closePanel);
    document.getElementById('pe-overlay').addEventListener('click', function (e) {
      if (e.target === this) closePanel();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });

    attachCartIntercept();
  }

  // ─── API ──────────────────────────────────────────────────────────────────
  function showCard(product) {
    if (!product) return;
    if (sessionStorage.getItem('pe_dismissed')) {
      log.info('Card suppressed — dismissed this session');
      return;
    }
    log.info('Showing card »', product.name, '| price:', product.displayPrice ?? product.price);

    const img  = document.getElementById('pe-img');
    const ph   = document.getElementById('pe-img-ph');

    if (product.image) {
      img.src   = product.image;
      img.alt   = product.name || '';
      img.style.display = 'block';
      ph.style.display  = 'none';
      img.onerror = () => { img.style.display = 'none'; ph.style.display = 'flex'; };
    } else {
      img.style.display = 'none';
      ph.style.display  = 'flex';
    }

    document.getElementById('pe-cat').textContent  = firstCat(product.category).toUpperCase() || '';
    document.getElementById('pe-name').textContent = product.name || '—';
    document.getElementById('pe-price').textContent = fmt(product.price);

    const pl = promoLabel(product.promotions);
    document.getElementById('pe-promo-tag').textContent = pl ? `• ${pl}` : '';

    const origEl = document.getElementById('pe-orig-price');
    if (product.originalPrice != null) {
      origEl.textContent  = fmt(product.originalPrice);
      origEl.style.display = 'inline';
    } else {
      origEl.style.display = 'none';
    }

    document.getElementById('pe-card-wrap').classList.add('pe-open');
    trackEvent('view', product);
  }

  function dismiss() {
    log.info('Card dismissed for this session');
    document.getElementById('pe-card-wrap').classList.remove('pe-open');
    sessionStorage.setItem('pe_dismissed', '1');
  }

  function openPanel() {
    log.info(`Panel opened — showing ${_products.length} product(s)`);
    renderGrid(_products);
    document.getElementById('pe-overlay').classList.add('pe-open');
  }

  function closePanel() {
    log.info('Panel closed');
    document.getElementById('pe-overlay').classList.remove('pe-open');
  }

  function renderGrid(products) {
    const grid = document.getElementById('pe-grid');
    if (!products.length) {
      grid.innerHTML = '<p style="color:rgba(255,255,255,0.38);font-size:13px">No products to show.</p>';
      return;
    }
    grid.innerHTML = products.map((p, idx) => {
      const imgEl = p.image
        ? `<img class="pe-item-img" src="${esc(p.image)}" alt="${esc(p.name)}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" loading="lazy" />
           <div class="pe-item-img-ph" style="display:none">🏷️</div>`
        : `<div class="pe-item-img-ph">🏷️</div>`;

      return `
        <div class="pe-item"
             data-pe-idx="${idx}"
             onclick="PromoWidget._click(${idx})">
          <div class="pe-item-img-wrap">
            ${imgEl}
            <div class="pe-item-dot"></div>
          </div>
          <div class="pe-item-body">
            <div class="pe-item-cat">${esc(firstCat(p.category))}</div>
            <div class="pe-item-name">${esc(p.name || '—')}</div>
            <div class="pe-item-footer">
              <span>
                <span class="pe-item-price">${fmt(p.price)}</span>
                ${p.originalPrice != null ? `<span class="pe-item-orig">${fmt(p.originalPrice)}</span>` : ''}
              </span>
              ${p.url ? `<a class="pe-item-link" href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderAffinities(snapshot) {
    const wrap = document.getElementById('pe-affinities');
    const cats = snapshot?.topCategories || [];
    if (!cats.length) { wrap.style.display = 'none'; return; }
    wrap.querySelectorAll('.pe-aff-pill').forEach(el => el.remove());
    cats.forEach(c => {
      const pill = document.createElement('span');
      pill.className   = 'pe-aff-pill';
      pill.textContent = `${c.category} ${c.affinity.toFixed(0)}`;
      wrap.appendChild(pill);
    });
    wrap.style.display = 'flex';
  }

  // ─── Fetch ────────────────────────────────────────────────────────────────
  async function fetchPromos() {
    const sid = ensureSessionId();
    log.info(`Fetching promotions… session=${sid} limit=${cfg.limit}`);
    const t0 = Date.now();
    try {
      const body = { limit: cfg.limit, session_id: sid };

      const resp = await fetch(`${cfg.server}/promotions/discover`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body:    JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _products = data.products || [];

      if (_products.length === 0) {
        log.warn('No promotions returned — card will not show.');
        return;
      }

      log.group(`${_products.length} promotions received in ${Date.now() - t0}ms`);
      log.info('Personalized:', data.personalized ? 'yes' : 'no');
      log.info('Top product:', _products[0]?.name, '| display price:', _products[0]?.displayPrice);
      log.info('All products:', _products.map(p => p.name));
      log.end();

      // panel meta
      document.getElementById('pe-panel-count').textContent = `${_products.length} ${t.products}`;
      const persEl = document.getElementById('pe-panel-pers');
      persEl.style.display = data.personalized ? 'inline' : 'none';

      renderAffinities(data.profileSnapshot);

      // show card after short delay
      setTimeout(() => showCard(_products[0]), 1500);

    } catch (err) {
      log.error('Promotions fetch failed:', err.message);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  window.PromoWidget = {
    open:       openPanel,
    close:      closePanel,
    reload:     fetchPromos,
    sessionId:  ensureSessionId,   // call to read the current session ID
    // internal: called from inline onclick on panel items
    _click(idx) {
      const p = _products[idx];
      if (!p) return;
      trackEvent('click', p);
      if (p.url) window.open(p.url, '_blank');
    },
  };

  // ─── Boot — loader pattern (mirrors Semantix loader) ─────────────────────
  //
  //  CACHED PATH  → apply cached config, mount immediately (zero network wait),
  //                 refresh config silently in background for next visit.
  //
  //  COLD PATH    → mount with safe defaults right away (CSS + HTML injected,
  //                 cart intercept attached), then fetch config + promos together.
  //                 User sees the card as soon as both respond — no extra round-trip.

  function boot() {
    log.group('PromoWidget boot');
    log.info('API key:', API_KEY.slice(0, 8) + '…', '| server:', cfg.server);
    log.info('Session ID:', ensureSessionId());
    const cached = readCfgCache();

    if (cached) {
      log.info('Cache hit — loading instantly, refreshing config in background');
      log.end();
      applyCfg(cached);
      mount();
      fetchPromos();
      fetchCfg(fresh => {
        if (fresh) {
          log.info('Background config refresh complete');
          writeCfgCache(fresh);
        }
      });
    } else {
      log.info('Cache miss — cold start, fetching config then promotions');
      log.end();
      mount();
      fetchCfg(data => {
        applyCfg(data);
        fetchPromos();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
