/* =====================================================================
 * ribbon-overlay.js  —  drop-in patch for ClearSky OMEGA
 * ---------------------------------------------------------------------
 * THE BUG
 *
 * #cw (canvas wrapper) is `flex:1`. #ribbon is an in-flow sibling with
 * `height:var(--ribbon-h)` (82px desktop, 74px narrow). Collapsing the
 * ribbon sets that height to 0, so #cw grows by 82px.
 *
 * Two things then move in opposite directions:
 *
 *   1. The map div gets taller. google.maps resize keeps the CENTER
 *      fixed, so the ground slides down ~41px relative to the old top
 *      edge.
 *   2. #els and #csvg are `top:0;height:100%` of #cw. Element pixel
 *      coordinates are measured from the TOP, so they don't move.
 *
 * Net result: every placed item shifts ~41px against the imagery. At the
 * zoom in your screenshots that's roughly 40 feet on the ground.
 *
 * toggleRibbon() currently chases this with a 60ms timeout, a map resize
 * trigger, a synthetic window resize, and two passes of
 * _geoReprojectAll() at 60ms and 220ms. That's a race, and it only ever
 * corrects items that carry a geo anchor.
 *
 * THE FIX
 *
 * Take the ribbon out of layout flow and float it over the top of the
 * canvas. #cw then never changes size, the map never resizes, and
 * nothing has to be reprojected — the whole cascade becomes unnecessary
 * rather than better-timed.
 *
 * INSTALL
 *
 *   <script src="ribbon-overlay.js"></script>
 *
 * after the ribbon controller script (the one defining toggleRibbon,
 * around line 1511). No other edits. Call RibbonOverlay.uninstall() to
 * revert at runtime if you want to A/B it.
 *
 * SCOPE — worth being clear about
 *
 * This fixes the ribbon. It does NOT fix window resize, browser zoom,
 * device rotation, the mobile URL bar hiding, or any other panel that
 * takes layout space. All of those resize #cw the same way and produce
 * the same drift. Geo-anchoring the drawing layer (geo-overlay.js) is
 * what makes the entire class harmless; this patch fixes the one case
 * you're hitting today.
 * ===================================================================== */
(function () {
  'use strict';

  var STYLE_ID = 'ribbon-overlay-style';
  var installed = false;
  var origToggle = null;
  var ro = null;

  var CSS = [
    /* Float the ribbon above the canvas instead of stacking above it.    */
    '#ribbon{',
    '  position:fixed !important;',
    '  z-index:150;',
    '  height:var(--ribbon-h);',
    /* The existing `background:` shorthand sets background-color to      */
    /* transparent, which would let satellite imagery show through the    */
    /* gaps between the scroll-shadow gradients. A later background-color */
    /* declaration wins and gives it an opaque base.                      */
    '  background-color:var(--bg);',
    '  border-bottom:1px solid var(--border);',
    '  box-shadow:0 10px 28px rgba(0,0,0,.45);',
    '  transition:opacity .16s ease, transform .16s ease;',
    '}',
    /* Collapsed: hide it in place. Height is untouched, so #cw never     */
    /* reflows. pointer-events:none is what stops an invisible ribbon     */
    /* from swallowing clicks meant for the canvas underneath.            */
    'body.ribbon-collapsed #ribbon{',
    '  opacity:0 !important;',
    '  transform:translateY(-10px) !important;',
    '  pointer-events:none !important;',
    '  height:var(--ribbon-h) !important;',
    '  min-height:var(--ribbon-h) !important;',
    '  overflow:hidden !important;',
    '  border-bottom:1px solid var(--border) !important;',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  #ribbon{transition:none !important}',
    '}'
  ].join('\n');

  function el(id) { return document.getElementById(id); }

  /**
   * Pin the floating ribbon to the top edge of the canvas.
   *
   * Read from #cw rather than hardcoding an offset: the tab strip, the
   * document tabs, and the status bar all vary in height across
   * breakpoints, and #cw's top edge is the one measurement that is
   * correct in every case. Once the ribbon is out of flow that edge no
   * longer moves, so this converges immediately instead of oscillating.
   */
  function sync() {
    var cw = el('cw'), rb = el('ribbon');
    if (!cw || !rb) return;
    var r = cw.getBoundingClientRect();
    if (!r.width) return;                 // hidden tab — nothing to place
    rb.style.top = r.top + 'px';
    rb.style.left = r.left + 'px';
    rb.style.width = r.width + 'px';
    rb.style.right = 'auto';
  }

  /**
   * Replacement toggle. Same persistence and same class, minus the
   * resize/reproject cascade — there is no longer anything to correct.
   */
  function toggleRibbon(force) {
    var collapsed = (typeof force === 'boolean')
      ? force
      : !document.body.classList.contains('ribbon-collapsed');
    document.body.classList.toggle('ribbon-collapsed', collapsed);
    try { localStorage.setItem('ribbonCollapsed', collapsed ? '1' : '0'); } catch (e) {}
    // Geometry is unchanged, so the only thing that can need updating is
    // the ribbon's own pin — and only if a breakpoint changed --ribbon-h.
    sync();
    return collapsed;
  }

  function install() {
    if (installed) return;
    var rb = el('ribbon'), cw = el('cw');
    if (!rb || !cw) {
      console.warn('[ribbon-overlay] #ribbon or #cw not found — patch not applied.');
      return;
    }

    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);

    // `function toggleRibbon(){}` at the top level of a classic script
    // shares its binding with the global object, so reassigning here also
    // redirects _ribbonReopenOnTab()'s internal call.
    origToggle = window.toggleRibbon;
    window.toggleRibbon = toggleRibbon;

    sync();
    // Two extra passes catch webfont swap and the mobile URL bar settling.
    setTimeout(sync, 60);
    setTimeout(sync, 400);

    if (window.ResizeObserver) {
      ro = new ResizeObserver(sync);
      ro.observe(cw);
    }
    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('orientationchange', sync, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', sync, { passive: true });
    }

    installed = true;
  }

  function uninstall() {
    if (!installed) return;
    var s = el(STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
    var rb = el('ribbon');
    if (rb) { rb.style.top = rb.style.left = rb.style.width = rb.style.right = ''; }
    if (origToggle) window.toggleRibbon = origToggle;
    if (ro) { ro.disconnect(); ro = null; }
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', sync);
    installed = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  window.RibbonOverlay = { install: install, uninstall: uninstall, sync: sync };
})();
