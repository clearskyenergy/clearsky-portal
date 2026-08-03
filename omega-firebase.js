/* ══════════════════════════════════════════════════════════════════════
   omega-firebase.js  —  ClearSky-OMEGA
   ----------------------------------------------------------------------
   ONE Firebase init for every shared tool on TOOL_HOST.

   Include it AFTER the firebase-*-compat scripts and BEFORE the tool's own
   script. Any tool that needs auth or Firestore gets both from here, so a
   project change is a one-file edit rather than a sweep through 35 tools.

       <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
       <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js"></script>
       <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js"></script>
       <script src="./omega-firebase.js"></script>
       <script src="./omega-tools.js"></script>
       <script src="./omega-intake.js"></script>

   THESE VALUES ARE NOT SECRET. A Firebase web config is public by design —
   it identifies the project, it does not authorise anything. Access is
   decided by Firestore rules and the authorised-domains list, both of which
   are server side. Shipping it in a static file is the intended pattern.

   WHERE TO GET THEM
   Firebase console → Project settings → General → Your apps → Web app →
   "SDK setup and configuration" → Config. Or open any tool that already
   works (grid-atlas.html, battery-sizer.html) and copy the block from its
   source — they are the same six values.

   AFTER FILLING THIS IN
   Firebase console → Authentication → Settings → Authorised domains must
   include tools.csebuilders.com, or sign-in fails with
   auth/unauthorized-domain even though the config is correct.
   ══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var CONFIG = {
    apiKey:            'REPLACE_ME',
    authDomain:        'REPLACE_ME.firebaseapp.com',
    projectId:         'REPLACE_ME',
    storageBucket:     'REPLACE_ME.appspot.com',
    messagingSenderId: 'REPLACE_ME',
    appId:             'REPLACE_ME'
  };

  global.OMEGA_FIREBASE = CONFIG;

  if (!global.firebase || typeof global.firebase.initializeApp !== 'function') {
    console.warn('[omega-firebase] firebase SDK not loaded before this file.');
    return;
  }
  if (global.firebase.apps && global.firebase.apps.length) return;   // already up

  try {
    global.firebase.initializeApp(CONFIG);
  } catch (e) {
    console.warn('[omega-firebase] initializeApp failed', e);
  }

  /* Keep the session across visits. Each origin holds its own Firebase
     session, so a tool on TOOL_HOST signs in once and stays signed in —
     it does not inherit the portal's session, and never will. */
  try {
    if (global.firebase.auth) {
      global.firebase.auth().setPersistence(
        global.firebase.auth.Auth.Persistence.LOCAL
      )['catch'](function () {});
    }
  } catch (e) {}
})(window);
