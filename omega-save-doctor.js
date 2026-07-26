/* =====================================================================
 * omega-save-doctor.js  —  Say WHY the save failed
 * ---------------------------------------------------------------------
 * Drop-in, read-only. It changes no save behaviour; it only observes and
 * reports. Add before </body>:
 *
 *     <script src="omega-save-doctor.js"></script>
 *
 * WHY THIS EXISTS
 *
 * saveProject() has two failure exits and neither tells you which one
 * you hit:
 *
 *   1. `if(!_currentUser || !_db)` — not signed in. It calls
 *      _setSaved('err') and points you at the Sign In button... which
 *      is hidden, because auth is delegated to the host portal. So a
 *      failed portal auth handoff shows "!! Save failed" and directs
 *      you to a control you cannot see.
 *
 *   2. The catch around the write. The real reason goes to
 *      console.error('Save error:', e) and the user sees only
 *      "check your connection" — which is usually wrong. The common
 *      real causes are a Firestore permission-denied, an `undefined`
 *      field the sanitiser missed, or the 1 MiB per-document limit.
 *
 * This surfaces the actual cause in the status bar and the console.
 *
 * SAFE TO REMOVE: delete the script tag.
 * ===================================================================== */
(function () {
  'use strict';

  var DOC_LIMIT = 1048576;          // Firestore hard limit, bytes per document
  var lastWriteBytes = 0;
  var lastWritePath = '';

  /* ---------------- reporting ---------------- */

  function report(kind, detail) {
    var el = document.getElementById('pn-saved');
    if (el) {
      el.textContent = '!! ' + kind;
      el.style.color = 'var(--red)';
      el.title = detail || '';
      el.style.cursor = 'help';
    }
    if (window.console) console.warn('[save-doctor] ' + kind + (detail ? ' — ' + detail : ''));
    try {
      if (typeof window.showBanner === 'function') {
        window.showBanner('wiz', '!! Save failed: ' + kind + (detail ? ' — ' + detail : ''));
      }
    } catch (e) {}
  }

  function authState() {
    try {
      if (!window.firebase || !firebase.auth) return { ok: false, why: 'Firebase auth SDK not loaded' };
      var u = firebase.auth().currentUser;
      if (!u) return { ok: false, why: 'no signed-in user (portal auth handoff did not complete)' };
      return { ok: true, uid: u.uid, email: u.email || '(no email)' };
    } catch (e) {
      return { ok: false, why: 'auth check threw: ' + (e && e.message) };
    }
  }

  /* ---------------- payload size probe ----------------
   * Wraps DocumentReference.set/update purely to measure. The JSON byte
   * count is an approximation — Firestore also charges for field names
   * and type overhead — so treat anything over ~90% of the limit as the
   * likely cause rather than a certainty.
   * ---------------------------------------------------- */

  function patchFirestore() {
    try {
      if (!window.firebase || !firebase.firestore) return false;
      var DR = firebase.firestore.DocumentReference;
      if (!DR || !DR.prototype || DR.prototype.__omegaProbed) return false;

      ['set', 'update'].forEach(function (m) {
        var orig = DR.prototype[m];
        if (typeof orig !== 'function') return;
        DR.prototype[m] = function (data) {
          try {
            lastWriteBytes = new Blob([JSON.stringify(data)]).size;
            lastWritePath = (this && this.path) || '';
            if (lastWriteBytes > DOC_LIMIT * 0.9) {
              console.warn('[save-doctor] document is ' +
                (lastWriteBytes / 1024).toFixed(0) + ' KiB of a 1024 KiB limit — ' +
                'likely an embedded image. Check mapState / snapshot fields.');
            }
          } catch (e) { lastWriteBytes = 0; }
          return orig.apply(this, arguments);
        };
      });
      DR.prototype.__omegaProbed = true;
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- capture the real error ----------------
   * saveProject's catch logs console.error('Save error:', e). Reading it
   * here is more reliable than trying to re-enter the save path.
   * -------------------------------------------------------- */

  function patchConsole() {
    if (console.error.__omegaWrapped) return;
    var orig = console.error;
    var wrapped = function () {
      try {
        if (String(arguments[0] || '').indexOf('Save error') === 0) {
          var e = arguments[1] || {};
          var code = e.code || '';
          var msg = e.message || String(e);
          var why;

          if (code === 'permission-denied') {
            why = 'Firestore rules rejected the write. Check the rule for this ' +
                  'collection and that the signed-in uid is allowed.';
          } else if (/Unsupported field value: undefined/i.test(msg)) {
            why = 'an undefined field slipped past _stripUndefinedInPlace — ' +
                  'Firestore rejects the ENTIRE write. Look at the newest ' +
                  'shape or element type you added.';
          } else if (code === 'invalid-argument' && lastWriteBytes > DOC_LIMIT * 0.8) {
            why = 'document is ' + (lastWriteBytes / 1024).toFixed(0) +
                  ' KiB, near the 1024 KiB limit — something large is being ' +
                  'embedded, most likely a map snapshot data URI.';
          } else if (code === 'unauthenticated') {
            why = 'auth token expired or was never issued by the portal.';
          } else if (code === 'unavailable') {
            why = 'Firestore unreachable — this one really is the network.';
          } else {
            why = msg + (code ? ' [' + code + ']' : '');
          }
          report(code || 'write rejected', why);
          if (lastWritePath) {
            console.warn('[save-doctor] target: ' + lastWritePath +
                         ' (' + (lastWriteBytes / 1024).toFixed(1) + ' KiB)');
          }
        }
      } catch (err) { /* never let diagnostics break logging */ }
      return orig.apply(console, arguments);
    };
    wrapped.__omegaWrapped = true;
    console.error = wrapped;
  }

  /* ---------------- distinguish the auth exit ----------------
   * The auth path returns before any write, so no console.error fires.
   * Wrapping saveProject lets us tell "never attempted" apart from
   * "attempted and rejected".
   * ----------------------------------------------------------- */

  function patchSave() {
    if (typeof window.saveProject !== 'function' || window.saveProject.__omegaWrapped) return false;
    var orig = window.saveProject;
    var wrapped = async function () {
      var a = authState();
      var before = lastWriteBytes;
      var r = await orig.apply(this, arguments);
      var el = document.getElementById('pn-saved');
      var failed = el && el.textContent.indexOf('!!') === 0;
      // Failed, but nothing was ever sent -> the pre-flight auth guard.
      if (failed && lastWriteBytes === before && !a.ok) {
        report('not signed in', a.why +
          '. The Sign In button is hidden because auth is delegated to the ' +
          'portal, so there is nothing to click — re-open the editor from ' +
          'the portal, or check the token handoff.');
      }
      return r;
    };
    wrapped.__omegaWrapped = true;
    window.saveProject = wrapped;
    return true;
  }

  /* ---------------- manual check ---------------- */

  window.OmegaSaveDoctor = {
    check: function () {
      var a = authState();
      var out = {
        auth: a,
        firestoreSDK: !!(window.firebase && window.firebase.firestore),
        lastWriteKiB: +(lastWriteBytes / 1024).toFixed(1),
        lastWritePath: lastWritePath,
        limitKiB: DOC_LIMIT / 1024,
        statusText: (document.getElementById('pn-saved') || {}).textContent || '(no indicator)'
      };
      if (window.console) console.table ? console.table(out) : console.log(out);
      return out;
    }
  };

  /* ---------------- boot ---------------- */

  function boot() {
    patchConsole();
    var tries = 0;
    var t = setInterval(function () {
      var done = patchFirestore() | patchSave();
      if (++tries > 40 || (window.saveProject && window.saveProject.__omegaWrapped &&
          window.firebase && firebase.firestore &&
          firebase.firestore.DocumentReference.prototype.__omegaProbed)) {
        clearInterval(t);
        if (window.console) {
          console.info('[save-doctor] armed. Run OmegaSaveDoctor.check() any time.');
        }
      }
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
