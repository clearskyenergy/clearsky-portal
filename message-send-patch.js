/* ===========================================================================
   PATCH — client message send in intake.html
   ---------------------------------------------------------------------------
   Replaces the #ppSend handler around line 1497. Two things it fixes:

   1. Failures are currently silent from where the client is standing. fail()
      routes to setMsg(), which writes into #statusMsg down in the fixed action
      bar — a different part of the page from the message thread the client is
      looking at. If the write is rejected, the button just greys out. This
      version prints the error inline under the composer AND re-enables the
      button, so a failure looks like a failure.

   2. after() re-renders the thread from the in-memory `rec`. If OI.postMessage
      persists to Firestore without also pushing onto rec.messages, the send
      succeeds and the message still vanishes on re-render. This version
      appends locally as a fallback when the record didn't come back changed.

   Paste over the existing `var bS = $('#ppSend'); ...` block.
   =========================================================================== */

var bS = $('#ppSend');
if (bS) bS.addEventListener('click', function () {
  var box = $('#ppMsg');
  var text = (box && box.value || '').trim();
  if (!text) return;

  /* Error surface that lives next to the composer, not in the action bar. */
  var errSlot = document.getElementById('ppErr');
  if (!errSlot) {
    errSlot = document.createElement('div');
    errSlot.id = 'ppErr';
    errSlot.style.cssText = 'color:#B4302A;font-size:12.5px;margin-top:8px;display:none';
    var host = bS.parentNode;
    if (host && host.parentNode) host.parentNode.insertBefore(errSlot, host.nextSibling);
  }
  function showErr(msg) {
    errSlot.textContent = msg;
    errSlot.style.display = 'block';
  }
  errSlot.style.display = 'none';

  /* Never let the button die in the disabled state. */
  function release() { bS.disabled = false; bS.textContent = 'Send'; }

  bS.disabled = true;
  bS.textContent = 'Sending\u2026';

  var before = ((rec.messages || []).length);
  var sender = me || (user && user.email) || '';

  if (!sender) {
    release();
    showErr('Not signed in \u2014 reload the page and sign in again.');
    return;
  }
  if (typeof OI.postMessage !== 'function') {
    release();
    showErr('Messaging is unavailable on this build (OI.postMessage missing).');
    console.error('[intake] OI.postMessage is not defined \u2014 check omega-intake.js version');
    return;
  }

  Promise.resolve(OI.postMessage(rec, text, 'client', sender))
    .then(function (res) {
      /* If the helper returned the saved record, adopt it. If it mutated `rec`
         in place, the length check catches that. Otherwise append by hand so
         the re-render below has something to draw. */
      if (res && res.messages) {
        rec = res;
      } else if ((rec.messages || []).length === before) {
        if (!rec.messages) rec.messages = [];
        rec.messages.push({
          text: text,
          side: 'client',
          by: sender,
          at: new Date().toISOString(),
        });
      }
      if (box) box.value = '';
      hydrate();
      renderNotice();
      refreshList();
    })
    .catch(function (e) {
      release();
      var code = (e && (e.code || e.name)) || '';
      var msg = (e && e.message) || 'Message did not send.';

      /* Permission-denied is the single most likely cause here and deserves
         its own wording — it means the rules, not the code, are the problem. */
      if (/permission|denied/i.test(code + ' ' + msg)) {
        msg = 'You don\u2019t have permission to post to this project. '
            + 'Contact support and mention error: ' + (code || 'permission-denied');
      }
      showErr(msg);
      console.error('[intake] postMessage failed', { code: code, error: e, intakeId: rec.intakeId });
    });
});

/* ===========================================================================
   FIRESTORE RULES — the usual culprit
   ---------------------------------------------------------------------------
   A client posting a message is a WRITE to a record they usually only have
   read access to. If your rules gate updates on staff, or on a field the
   client can't satisfy, the write is rejected. Rule shape that permits a
   client to append messages without letting them touch status, quote, or
   anyone else's fields:

   match /omega_orgs/{orgId}/intakes/{intakeId} {
     allow read: if isOwner() || isStaff();

     allow update: if isStaff()
       || (isOwner() && onlyChanged(['messages', 'notify', 'acceptance', 'payment']));

     function isOwner() {
       return request.auth != null &&
         request.auth.token.email.lower() == resource.data.customer.email.lower();
     }
     function isStaff() {
       return request.auth != null &&
         request.auth.token.email.matches('.*@(clearsky-usa|csebuilders)[.]com');
     }
     function onlyChanged(fields) {
       return request.resource.data.diff(resource.data)
              .affectedKeys().hasOnly(fields);
     }
   }

   Note the owner check reads customer.email. If a client signs in with a
   different address than the one typed into the intake form, they are not the
   owner by this rule and every message they send is denied. Storing the
   submitter's uid on the record at submit time is sturdier than matching
   on a typed email.
   =========================================================================== */
