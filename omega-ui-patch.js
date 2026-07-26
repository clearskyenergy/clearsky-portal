/* =====================================================================
 * omega-ui-patch.js  —  Float the ribbon over the canvas
 * ---------------------------------------------------------------------
 * Drop-in. Nothing in editor.html needs editing; add ONE line before
 * </body>:
 *
 *     <script src="omega-ui-patch.js"></script>
 *
 * WHAT IT FIXES
 *
 * `body` is a flex column: #tb -> #ribbon -> #doc-tabs -> #tabs -> #ws
 * (flex:1) -> #statusbar. #sc is absolutely positioned inside #ws. So
 * every fixed-height bar subtracts directly from the canvas, and
 * expanding or collapsing the ribbon RESIZES the canvas.
 *
 * That resize is what forces toggleRibbon() to trigger a map resize and
 * then reproject every geo-anchored element — twice, on a 60 ms and a
 * 220 ms timer, racing browser layout. That race is the "elements
 * relocate when I minimize the tab" bug, and a timer-based fix works
 * only when layout happens to finish first.
 *
 * Taking the ribbon out of flow means #ws never changes height, #sc
 * never resizes, and there is nothing to reproject. The race cannot
 * occur because the event that starts it no longer happens.
 *
 * This is the same move already made for the right panel — see the
 * comment on #rp: "now floats over the canvas ... so the site map gets
 * the full width." Same fix, vertical axis.
 *
 * SAFE TO REMOVE: delete the script tag and everything reverts.
 * ===================================================================== */
(function () {
  'use strict';

  var PIN_KEY = 'omegaRibbonPinned';
  var patched = false;

  /* ---------------- CSS ---------------- */

  function injectCSS() {
    if (document.getElementById('omega-ui-patch-css')) return;
    var css = [
      /* Positioning context for the floated ribbon. */
      'body{position:relative;}',

      /* Out of flow, anchored just under the tab rows, above the canvas. */
      '#ribbon{',
      '  position:absolute!important;',
      '  top:var(--omega-ribbon-top,96px)!important;',
      '  left:0!important; right:0!important;',
      '  z-index:300!important;',
      '  box-shadow:0 10px 28px rgba(0,0,0,.55);',
      '  border-bottom:1px solid var(--border);',
      '}',

      /* Their rule collapses via height:0 !important, which still leaves a
         1px border and keeps the node in the layout box. display:none is
         unambiguous now that it is out of flow. */
      'body.ribbon-collapsed #ribbon{display:none!important;}',

      /* Pin control, injected next to the existing collapse chevron. */
      '#omega-ribbon-pin{',
      '  display:flex;align-items:center;justify-content:center;',
      '  width:30px;height:30px;margin-right:2px;border-radius:6px;',
      '  cursor:pointer;color:var(--sub);flex-shrink:0;user-select:none;',
      '  font-size:13px;transition:background .15s,color .15s;',
      '}',
      '#omega-ribbon-pin:hover{background:rgba(255,255,255,.08);color:var(--text);}',
      '#omega-ribbon-pin.on{color:var(--hl);background:rgba(255,255,255,.06);}'
    ].join('\n');

    var s = document.createElement('style');
    s.id = 'omega-ui-patch-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------------- geometry ----------------
   * The ribbon floats directly beneath whichever tab row is last in the
   * header stack. Measured rather than hardcoded, because #doc-tabs
   * wraps to two rows when a project has many canvas tabs.
   * ------------------------------------------ */

  function syncTop() {
    var anchor = document.getElementById('tabs') ||
                 document.getElementById('doc-tabs') ||
                 document.getElementById('tb');
    if (!anchor) return;
    var top = anchor.offsetTop + anchor.offsetHeight;
    if (!(top > 0)) return;
    document.documentElement.style.setProperty('--omega-ribbon-top', top + 'px');
  }

  /* ---------------- pin ---------------- */

  function isPinned() {
    try { return localStorage.getItem(PIN_KEY) === '1'; } catch (e) { return false; }
  }
  function setPinned(on) {
    try { localStorage.setItem(PIN_KEY, on ? '1' : '0'); } catch (e) {}
    var b = document.getElementById('omega-ribbon-pin');
    if (b) {
      b.classList.toggle('on', !!on);
      b.title = on ? 'Ribbon pinned open — click to auto-close after each tool'
                   : 'Ribbon auto-closes after each tool — click to pin open';
    }
  }
  function addPinButton() {
    if (document.getElementById('omega-ribbon-pin')) return;
    var collapse = document.getElementById('ribbon-collapse-btn');
    if (!collapse || !collapse.parentNode) return;
    var b = document.createElement('div');
    b.id = 'omega-ribbon-pin';
    b.textContent = '\uD83D\uDCCC';                 // pushpin
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      setPinned(!isPinned());
    });
    collapse.parentNode.insertBefore(b, collapse);
    setPinned(isPinned());
  }

  /* ---------------- toggleRibbon ----------------
   * Replaces the original. The original's entire body after the class
   * toggle was resize-and-reproject compensation; none of it is needed
   * once the canvas stops changing size.
   *
   * _geoReprojectAll is NOT orphaned by this — it is still bound to the
   * map's own 'idle' event and to the rAF loop, which is where it
   * belongs.
   * ---------------------------------------------- */

  function patchToggle() {
    if (typeof window.toggleRibbon !== 'function') return false;
    window.toggleRibbon = function (force) {
      var collapsed = (typeof force === 'boolean')
        ? force
        : !document.body.classList.contains('ribbon-collapsed');
      document.body.classList.toggle('ribbon-collapsed', collapsed);
      try { localStorage.setItem('ribbonCollapsed', collapsed ? '1' : '0'); } catch (e) {}
      syncTop();
      // No map resize. No reprojection. #ws never changed height.
    };
    return true;
  }

  /* ---------------- auto-close ----------------
   * rbRun() is the single funnel every ribbon action passes through, so
   * one wrapper gives AutoCAD's "minimize to panel buttons" behaviour
   * without touching any individual button.
   * -------------------------------------------- */

  function patchRbRun() {
    if (typeof window.rbRun !== 'function' || window.rbRun.__omegaWrapped) return false;
    var orig = window.rbRun;
    var wrapped = function (fn) {
      var r = orig.apply(this, arguments);
      if (!isPinned()) {
        // Let the action's own DOM work finish before collapsing, so a
        // handler that reads ribbon state still sees it open.
        setTimeout(function () {
          try { window.toggleRibbon(true); } catch (e) {}
        }, 0);
      }
      return r;
    };
    wrapped.__omegaWrapped = true;
    window.rbRun = wrapped;
    return true;
  }

  /* ---------------- boot ---------------- */

  function apply() {
    if (patched) return;
    injectCSS();
    var okToggle = patchToggle();
    var okRun = patchRbRun();
    addPinButton();
    syncTop();
    if (okToggle && okRun) {
      patched = true;
      if (window.console) {
        console.info('[omega-ui-patch] ribbon floated; canvas no longer resizes on toggle');
      }
    }
  }

  function boot() {
    apply();
    // The editor defines toggleRibbon and rbRun inside a large inline
    // script; if this file loads first, retry briefly rather than fail.
    var tries = 0;
    var t = setInterval(function () {
      if (patched || ++tries > 40) { clearInterval(t); return; }
      apply();
    }, 100);

    addEventListener('resize', syncTop);
    // #doc-tabs grows when canvas tabs are added, which moves the anchor.
    if (window.ResizeObserver) {
      ['tabs', 'doc-tabs', 'tb'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) new ResizeObserver(syncTop).observe(el);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
