/**
 * notifyClientOnStaffActivity
 * ---------------------------------------------------------------------------
 * Emails the project owner / submitter whenever ADMIN-side activity lands on
 * their intake record: a new message, a new file or shared link, a status
 * change, or a quote being issued.
 *
 * Runs server-side so it cannot be skipped by a client that never opens the
 * portal, and so no mail credentials ever reach the browser.
 *
 * ---------------------------------------------------------------------------
 * SETUP (one time)
 *
 * 1. Install the Trigger Email extension — it owns the actual SMTP send, so
 *    this function only has to write a document:
 *
 *      firebase ext:install firebase/firestore-send-email --project=<project>
 *
 *    Answer its prompts with:
 *      Email documents collection : mail
 *      SMTP connection URI        : smtps://apikey:SG.xxxx@smtp.sendgrid.net:465
 *                                   (SendGrid, Postmark, Mailgun, Google
 *                                    Workspace SMTP relay — any of them)
 *      Default FROM address       : notifications@<your-domain>
 *
 * 2. Drop this file into functions/ and export it from functions/index.js:
 *
 *      exports.notifyClientOnStaffActivity =
 *        require('./notifyClientOnStaffActivity').notifyClientOnStaffActivity;
 *
 * 3. Set INTAKE_DOC_PATH below to whatever path OI.store() actually writes to
 *    (see the CONFIG note). Then:
 *
 *      firebase deploy --only functions:notifyClientOnStaffActivity
 *
 * 4. Lock the mail collection down in firestore.rules — only this function
 *    should ever write to it:
 *
 *      match /mail/{id} { allow read, write: if false; }
 * ---------------------------------------------------------------------------
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ══════════════════════════ CONFIG ══════════════════════════ */

/**
 * The Firestore path of an intake record. This is the ONE line you must
 * confirm against omega-intake.js — whatever collection OI.store().save()
 * writes to. Based on the branding lookup in intake.html (omega_orgs/{orgId})
 * the tenant-scoped shape below is the likely one; if records instead live in
 * a flat top-level collection, use 'intakes/{intakeId}' and drop {orgId} from
 * the handler.
 */
const INTAKE_DOC_PATH = 'omega_orgs/{orgId}/intakes/{intakeId}';

/** Where the Trigger Email extension picks up outbound mail. */
const MAIL_COLLECTION = 'mail';

/** Bookkeeping lives in its OWN collection, never on the intake doc — writing
 *  back to the intake would re-fire this trigger in a loop. */
const LOG_COLLECTION = 'omega_notify_log';

/** Don't send more than one email per record per this many minutes. An admin
 *  uploading six files in a row should produce one email, not six. */
const COOLDOWN_MINUTES = 10;

/** Fallbacks when the org document doesn't carry its own branding. */
const FALLBACK = {
  serviceName: 'Omega',
  fromName: 'Omega',
  portalUrl: 'https://portal.example.com/intake.html',
};

/* ══════════════════════════ TRIGGER ══════════════════════════ */

exports.notifyClientOnStaffActivity = onDocumentUpdated(
  { document: INTAKE_DOC_PATH, region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!before || !after) return;

    const { orgId, intakeId } = event.params;

    // A record still in draft has no owner expecting updates yet.
    if (!after.status || after.status === 'draft') return;

    // Per-record opt out, honoured everywhere.
    if (after.notify && after.notify.emailOptOut === true) return;

    const events = detectStaffEvents(before, after);
    if (!events.length) return;

    const recipients = resolveRecipients(after);
    if (!recipients.length) {
      logger.warn('No recipient email on intake', { orgId, intakeId });
      return;
    }

    const logRef = db.collection(LOG_COLLECTION).doc(`${orgId}__${intakeId}`);
    const log = (await logRef.get()).data() || {};

    // Cooldown: hold the event, let the next one carry it, unless it is
    // something the client should hear about immediately.
    const urgent = events.some((e) => e.urgent);
    const lastAt = log.lastEmailAt ? log.lastEmailAt.toMillis() : 0;
    const withinCooldown = Date.now() - lastAt < COOLDOWN_MINUTES * 60 * 1000;

    if (withinCooldown && !urgent) {
      await logRef.set(
        { pending: admin.firestore.FieldValue.arrayUnion(...events.map((e) => e.line)) },
        { merge: true }
      );
      return;
    }

    const carried = (log.pending || []).concat(events.map((e) => e.line));
    const org = await loadOrg(orgId);
    const mail = buildEmail({ org, record: after, orgId, intakeId, lines: carried });

    await db.collection(MAIL_COLLECTION).add({
      to: recipients,
      replyTo: org.supportEmail || undefined,
      from: `${org.fromName} <${org.fromAddress}>`,
      message: { subject: mail.subject, text: mail.text, html: mail.html },
    });

    await logRef.set(
      {
        lastEmailAt: admin.firestore.FieldValue.serverTimestamp(),
        pending: [],
        orgId,
        intakeId,
      },
      { merge: true }
    );

    logger.info('Client notified', { orgId, intakeId, count: carried.length });
  }
);

/* ══════════════════════ EVENT DETECTION ══════════════════════ */

/**
 * Diffs the two versions and returns only the changes an ADMIN caused.
 * Anything the client did to their own record is deliberately ignored —
 * nobody wants an email telling them they just sent a message.
 */
function detectStaffEvents(before, after) {
  const out = [];

  /* — messages from the admin side — */
  const seen = new Set((before.messages || []).map(msgKey));
  (after.messages || [])
    .filter((m) => m && m.side !== 'client' && !seen.has(msgKey(m)))
    .forEach((m) => {
      const preview = String(m.text || '').replace(/\s+/g, ' ').slice(0, 140);
      out.push({ urgent: true, line: `New message: “${preview}”` });
    });

  /* — files uploaded by the admin — */
  const hadFile = new Set((before.files || []).map((f) => f && f.id));
  const clientAddrs = new Set(resolveRecipients(after).map((e) => e.toLowerCase()));
  (after.files || [])
    .filter((f) => f && !hadFile.has(f.id))
    .filter((f) => !clientAddrs.has(String(f.by || f.uploadedBy || '').toLowerCase()))
    .forEach((f) => out.push({ urgent: false, line: `New file: ${f.name || 'untitled'}` }));

  /* — deliverable share links published by the admin — */
  const priorLinks = new Map(
    (before.deliverables || []).map((d) => [d.key, d.outputUrl || ''])
  );
  (after.deliverables || [])
    .filter((d) => d.outputUrl && priorLinks.get(d.key) !== d.outputUrl)
    .forEach((d) => out.push({ urgent: false, line: `Deliverable ready: ${d.label || d.key}` }));

  /* — status moved along the pipeline — */
  if (before.status !== after.status) {
    out.push({ urgent: true, line: `Status changed to ${humanStatus(after.status)}` });
  }

  /* — quote issued or revised — */
  const q0 = before.quote || {};
  const q1 = after.quote || {};
  if (q1.total != null && (q0.total !== q1.total || q0.issuedAt !== q1.issuedAt)) {
    out.push({
      urgent: true,
      line: `Quote ready: ${money(q1.total, q1.currency)} — review and approve in the portal`,
    });
  }

  /* — fallback — the admin tool flipped the unread flag but the change didn't
       match any pattern above. Better a vague email than a silent one. — */
  const flagRose =
    !(before.notify && before.notify.unreadForClient) &&
    !!(after.notify && after.notify.unreadForClient);
  if (!out.length && flagRose) {
    out.push({ urgent: false, line: 'Your project was updated' });
  }

  return out;
}

/* Messages have no stable id in the schema, so identity is content + time. */
function msgKey(m) {
  return `${m.at || ''}|${m.side || ''}|${String(m.text || '').slice(0, 80)}`;
}

/* ═══════════════════════ RECIPIENTS ═══════════════════════ */

/** Every address that legitimately represents the owner of this record. */
function resolveRecipients(rec) {
  const raw = [
    rec.customer && rec.customer.email,
    rec.submittedBy,
    rec.createdBy,
    rec.ownerEmail,
    ...(Array.isArray(rec.watchers) ? rec.watchers : []),
  ];
  const seen = new Set();
  return raw
    .filter((e) => typeof e === 'string' && /.+@.+\..+/.test(e))
    .filter((e) => {
      const k = e.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/* ═══════════════════════ COMPOSITION ═══════════════════════ */

async function loadOrg(orgId) {
  let d = {};
  try {
    const snap = await db.collection('omega_orgs').doc(orgId).get();
    d = snap.exists ? snap.data() : {};
  } catch (e) {
    logger.warn('Could not load org branding', { orgId, error: e.message });
  }
  return {
    serviceName: d.name || FALLBACK.serviceName,
    fromName: d.name || FALLBACK.fromName,
    fromAddress: d.notifyFrom || process.env.DEFAULT_FROM || 'notifications@example.com',
    supportEmail: d.supportEmail || (d.support && d.support.email) || '',
    portalUrl: d.portalUrl || FALLBACK.portalUrl,
    accent: d.accent || '#0E5FA8',
  };
}

function buildEmail({ org, record, orgId, intakeId, lines }) {
  const project = (record.project && record.project.name) || 'your project';
  const link = `${org.portalUrl}?org=${encodeURIComponent(orgId)}&intake=${encodeURIComponent(intakeId)}`;

  const subject =
    lines.length === 1
      ? `${project} — ${stripLabel(lines[0])}`
      : `${project} — ${lines.length} updates`;

  const text = [
    `There's an update on ${project}.`,
    '',
    ...lines.map((l) => `• ${l}`),
    '',
    `View it here: ${link}`,
    '',
    `— ${org.serviceName}`,
    org.supportEmail ? `Questions? Reply to this email or write to ${org.supportEmail}.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
            font-size:14px;line-height:1.55;color:#0F151C;max-width:560px">
  <p style="margin:0 0 14px">There's an update on <strong>${esc(project)}</strong>.</p>
  <ul style="margin:0 0 18px;padding-left:20px;color:#39434E">
    ${lines.map((l) => `<li style="margin-bottom:6px">${esc(l)}</li>`).join('')}
  </ul>
  <p style="margin:0 0 22px">
    <a href="${esc(link)}"
       style="display:inline-block;background:${esc(org.accent)};color:#fff;
              text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">
      Open your project
    </a>
  </p>
  <p style="margin:0;color:#6B7783;font-size:12.5px;border-top:1px solid #DCE3E9;padding-top:14px">
    ${esc(org.serviceName)}${
      org.supportEmail
        ? ` · Questions? Reply to this email or write to <a href="mailto:${esc(org.supportEmail)}"
             style="color:${esc(org.accent)}">${esc(org.supportEmail)}</a>.`
        : ''
    }
  </p>
</div>`.trim();

  return { subject, text, html };
}

/* ═══════════════════════ SMALL HELPERS ═══════════════════════ */

function stripLabel(line) {
  const i = line.indexOf(':');
  return i > -1 && i < 24 ? line.slice(0, i).toLowerCase() : line.slice(0, 60);
}

function humanStatus(s) {
  return String(s || '').replace(/[_-]+/g, ' ');
}

function money(total, currency) {
  const n = Number(total || 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(n);
  } catch (e) {
    return `${currency || '$'}${n.toFixed(2)}`;
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
