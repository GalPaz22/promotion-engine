/**
 * Promotion Engine — Loader
 *
 * This is the only file customers ever need to reference.
 * It reads window.PromoSettings, validates the API key, and
 * dynamically injects the full widget engine from the server.
 *
 * The loader URL is permanent and never changes.
 * The engine (widget.js) can be updated server-side at any time.
 *
 * Embed snippet (paste once into any page):
 *
 *   <script>
 *     window.PromoSettings = {
 *       apiKey:  "YOUR_API_KEY",
 *       server:  "https://promotion-engine-nnsk.onrender.com"   // optional
 *     };
 *     (function(d,s){
 *       var e=d.createElement(s); e.async=true;
 *       e.src=(window.PromoSettings.server||"https://promotion-engine-nnsk.onrender.com")+"/widget-loader.js";
 *       d.head.appendChild(e);
 *     })(document,"script");
 *   </script>
 */
(function () {
  var cfg = window.PromoSettings || {};

  if (!cfg.apiKey) {
    console.warn('[PromoLoader] window.PromoSettings.apiKey is required — widget disabled.');
    return;
  }

  // scriptBase  — where to load widget.js from (defaults to same origin as this loader file)
  // server      — where API calls go (config, promotions, signals) — can be a different host
  var loaderSrc  = (document.currentScript || {}).src || '';
  var loaderBase = loaderSrc ? loaderSrc.replace(/\/widget-loader\.js.*$/, '') : '';
  var scriptBase = (cfg.scriptBase || loaderBase || 'https://promotion-engine-nnsk.onrender.com').replace(/\/$/, '');

  // Allow overriding the full engine URL (e.g. for A/B testing or versioned deploys).
  var engineSrc = cfg.engineSrc || (scriptBase + '/widget.js?v=' + (cfg.v || '1'));

  // Avoid double-loading if the snippet fires twice
  if (window.__pe_loader_fired) return;
  window.__pe_loader_fired = true;

  var s = document.createElement('script');
  s.src   = engineSrc;
  s.async = true;
  document.head.appendChild(s);
})();
