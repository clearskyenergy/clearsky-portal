/* ============================================================================
 * omega-intake.js  —  ClearSky-OMEGA EnergyOS
 * Shared data layer + schema for the Project Intake tool.
 *
 * TENANT NEUTRALITY: this file ships byte-identical to every tenant.
 * Nothing tenant-specific lives here. All tenant values are read at runtime
 * from window.OMEGA_CONFIG (config.js) via cfg().
 * ==========================================================================*/
(function (global) {
  'use strict';

  var COLLECTION = 'intake_projects';

  /* ---------------------------------------------------------------- config */
  /* This tool is hosted ONCE on TOOL_HOST and opened by every tenant portal,
     so there is no tenant config.js on this origin. The portal passes the
     tenant through hrefFor() as ?org=<orgId>, exactly like every other shared
     tool. OMEGATools.orgFromUrl() is the canonical reader for that. */
  function cfg() {
    return global.OMEGA_CONFIG || global.omegaConfig || {};
  }

  /* Mirror of orgAlias() in firestore.rules. A tenant signing in from a
     secondary domain must resolve to the SAME org the rules will compute, or
     every write is rejected. Keep the two lists in step — if you add a domain
     here, add it in the rules, and vice versa. */
  var ORG_ALIASES = {
    'fenecon.de': 'fenecon.com',
    'fenecon.us': 'fenecon.com'
  };
  function orgAlias(domain) {
    domain = String(domain || '').toLowerCase();
    return ORG_ALIASES[domain] || domain;
  }

  var _org = null;
  function orgId() {
    if (_org) return _org;
    var fromUrl = null;
    if (global.OMEGATools && typeof global.OMEGATools.orgFromUrl === 'function') {
      fromUrl = global.OMEGATools.orgFromUrl(currentEmail());
    } else {
      var m = global.location && global.location.search
        ? global.location.search.match(/[?&]org=([^&]+)/) : null;
      if (m) fromUrl = decodeURIComponent(m[1]);
    }
    var c = cfg();
    _org = orgAlias(fromUrl || c.orgId || (c.tenant && c.tenant.orgId) || emailDomain());
    return _org;
  }
  function setOrg(o) { _org = orgAlias(o); }

  function currentEmail() {
    var c = cfg();
    if (c.user && c.user.email) return c.user.email;
    if (global.OMEGA_USER && global.OMEGA_USER.email) return global.OMEGA_USER.email;
    try {
      if (global.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.email;
      }
    } catch (e) {}
    return '';
  }
  function emailDomain() {
    var e = currentEmail();
    return e.indexOf('@') > -1 ? e.split('@')[1].toLowerCase() : '';
  }

  /* Tenant display name + service label. On TOOL_HOST there is no config.js,
     so these come from omega_orgs/{orgId} — the collection the portal already
     keeps per-tenant metadata in. Falls back to the org id, which is always
     something readable like 'fenecon.com'. */
  var _brand = null;
  function brand() { return _brand || {}; }
  function loadBrand(db) {
    if (!db) return Promise.resolve({});
    return db.collection('omega_orgs').doc(orgId()).get()
      .then(function (snap) {
        _brand = snap.exists ? (snap.data() || {}) : {};
        return _brand;
      })['catch'](function () { _brand = {}; return _brand; });
  }
  function tenantKey() { return orgId(); }
  function tenantName() {
    var b = brand();
    return b.name || b.displayName || b.company ||
           (cfg().tenant && cfg().tenant.name) || orgId();
  }
  function serviceName() {
    return brand().serviceName || cfg().serviceName || 'Omega';
  }

  /* The portal hands shared tools a ?return= link home, since a refresh loses
     the referrer across origins. */
  function returnUrl() {
    var m = global.location && global.location.search
      ? global.location.search.match(/[?&]return=([^&]+)/) : null;
    return m ? decodeURIComponent(m[1]) : (cfg().portalUrl || '');
  }

  /* The editor is itself a shared tool on TOOL_HOST, so route through the
     registry when it is present rather than guessing a relative path. */
  function editorUrl(projectId) {
    var base = cfg().editorUrl || '';
    if (!base && global.OMEGATools) {
      var t = global.OMEGATools.byKey('editor');
      if (t) base = global.OMEGATools.hrefFor(t, { orgId: orgId() }) || '';
    }
    if (!base) base = './editor.html';
    if (!projectId) return base;
    return base + (base.indexOf('?') > -1 ? '&' : '?') + 'project=' + encodeURIComponent(projectId);
  }

  // Deliberately no default. Shared code carries no reference to the operator's
  // own domain — a white-label tenant should never ship a string it didn't set.
  function adminOrigin() {
    return cfg().adminOrigin || '';
  }

  /* ------------------------------------------------------------- taxonomy */

  // Technology scopes. `fields` drive the form UI — add a scope here and both
  // the client tool and the admin console pick it up with no other changes.
  var SCOPES = [
    {
      key: 'l2', label: 'Level 2 charging', short: 'L2', unit: 'ports',
      summary: function (s) { return (s.ports || 0) + ' ports · ' + (s.kwPerPort || 0) + ' kW'; },
      fields: [
        { k: 'ports', l: 'Number of ports', t: 'number', ph: '8' },
        { k: 'kwPerPort', l: 'kW per port', t: 'number', ph: '11.5', step: '0.1' },
        { k: 'adaCount', l: 'ADA-accessible ports', t: 'number', ph: '1' },
        { k: 'mounting', l: 'Mounting', t: 'select', o: ['Pedestal', 'Wall-mount', 'Bollard', 'Mixed'] },
        { k: 'makeModel', l: 'Preferred make / model', t: 'text', ph: 'Open to recommendation' },
        { k: 'networked', l: 'Networked / OCPP', t: 'bool' },
        { k: 'loadMgmt', l: 'Automatic load management', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    },
    {
      key: 'dcfc', label: 'DC fast charging', short: 'DCFC', unit: 'dispensers',
      summary: function (s) { return (s.dispensers || 0) + ' dispensers · ' + (s.kwPerDispenser || 0) + ' kW'; },
      fields: [
        { k: 'dispensers', l: 'Number of dispensers', t: 'number', ph: '4' },
        { k: 'kwPerDispenser', l: 'kW per dispenser', t: 'number', ph: '350' },
        { k: 'cabinets', l: 'Number of power cabinets', t: 'number', ph: '2' },
        { k: 'architecture', l: 'Architecture', t: 'select', o: ['Cabinet + dispenser', 'All-in-one', 'Undecided'] },
        { k: 'adaCount', l: 'ADA-accessible stalls', t: 'number', ph: '1' },
        { k: 'makeModel', l: 'Preferred make / model', t: 'text', ph: 'Open to recommendation' },
        { k: 'pullThrough', l: 'Pull-through stalls required', t: 'bool' },
        { k: 'canopy', l: 'Canopy in scope', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    },
    {
      key: 'bess', label: 'Battery storage', short: 'BESS', unit: 'MWh',
      summary: function (s) { return (s.powerMw || 0) + ' MW / ' + (s.energyMwh || 0) + ' MWh'; },
      fields: [
        { k: 'powerMw', l: 'Power (MW)', t: 'number', ph: '5', step: '0.01' },
        { k: 'energyMwh', l: 'Energy (MWh)', t: 'number', ph: '20', step: '0.01' },
        { k: 'useCase', l: 'Primary use case', t: 'select', o: ['Peak shaving', 'Backup / resiliency', 'Energy arbitrage', 'Microgrid', 'EV charging buffer', 'Frequency response', 'Solar firming'] },
        { k: 'enclosure', l: 'Enclosure', t: 'select', o: ['Outdoor containerized', 'Outdoor cabinet', 'Indoor rack', 'Undecided'] },
        { k: 'vendor', l: 'Preferred vendor', t: 'text', ph: 'Open to recommendation' },
        { k: 'gridMode', l: 'Grid connection', t: 'select', o: ['Grid-tied', 'Grid-tied with islanding', 'Off-grid'] },
        { k: 'augmentation', l: 'Capacity augmentation planned', t: 'bool' },
        { k: 'nfpa855', l: 'NFPA 855 review needed', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    },
    {
      key: 'der', label: 'Distributed energy resources', short: 'DER', unit: 'kW',
      summary: function (s) { return (s.capacityKw || 0) + ' kW · ' + (s.assetTypes || 'assets'); },
      fields: [
        { k: 'assetTypes', l: 'Asset types', t: 'text', ph: 'Genset, fuel cell, CHP, microgrid controller' },
        { k: 'capacityKw', l: 'Total capacity (kW)', t: 'number', ph: '1500' },
        { k: 'fuel', l: 'Fuel', t: 'select', o: ['Natural gas', 'Diesel', 'Propane', 'Hydrogen', 'Biogas', 'N/A'] },
        { k: 'runHours', l: 'Expected annual run hours', t: 'number', ph: '200' },
        { k: 'islandMode', l: 'Island mode required', t: 'bool' },
        { k: 'blackStart', l: 'Black start required', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    },
    {
      key: 'solar', label: 'Solar PV', short: 'Solar', unit: 'kW-DC',
      summary: function (s) { return (s.dcKw || 0) + ' kW-DC · ' + (s.mounting || 'mounting TBD'); },
      fields: [
        { k: 'dcKw', l: 'DC capacity (kW)', t: 'number', ph: '850' },
        { k: 'acKw', l: 'AC capacity (kW)', t: 'number', ph: '650' },
        { k: 'mounting', l: 'Mounting', t: 'select', o: ['Rooftop', 'Ground mount', 'Carport', 'Mixed'] },
        { k: 'tracker', l: 'Single-axis tracking', t: 'bool' },
        { k: 'moduleMake', l: 'Preferred module', t: 'text', ph: 'Open to recommendation' },
        { k: 'inverterMake', l: 'Preferred inverter', t: 'text', ph: 'Open to recommendation' },
        { k: 'roofAge', l: 'Roof age / condition (if rooftop)', t: 'text', ph: '' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    },
    {
      key: 'compute', label: 'Compute / data center', short: 'Compute', unit: 'MW IT',
      summary: function (s) { return (s.itLoadMw || 0) + ' MW IT · ' + (s.cooling || 'cooling TBD'); },
      fields: [
        { k: 'itLoadMw', l: 'IT load (MW)', t: 'number', ph: '12', step: '0.1' },
        { k: 'phase1Mw', l: 'Phase 1 load (MW)', t: 'number', ph: '4', step: '0.1' },
        { k: 'rackDensityKw', l: 'Rack density (kW)', t: 'number', ph: '60' },
        { k: 'cooling', l: 'Cooling', t: 'select', o: ['Air', 'Rear-door heat exchanger', 'Direct-to-chip liquid', 'Immersion', 'Undecided'] },
        { k: 'redundancy', l: 'Redundancy', t: 'select', o: ['N', 'N+1', '2N', 'Undecided'] },
        { k: 'pue', l: 'Target PUE', t: 'number', ph: '1.25', step: '0.01' },
        { k: 'behindMeter', l: 'Behind-the-meter generation in scope', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    }
  ];

  // What Omega can produce. Order = the order shown in the client ledger and
  // the admin production checklist.
  var DELIVERABLES = [
    { key: 'siteplan', label: 'Project plot & site plan', hint: 'Dimensioned layout with setbacks, equipment pads and access.' },
    { key: 'sitemap', label: 'Site map', hint: 'Geo-referenced map, linked to your editor project.' },
    { key: 'costs', label: 'Cost estimate & BOM', hint: 'Equipment, civil, electrical and soft costs.' },
    { key: 'loadstudy', label: 'Load study & one-line', hint: 'Existing service capacity and proposed one-line.' },
    { key: 'utility', label: 'Utility submission package', hint: 'Application forms, drawings and load data for the serving utility.' },
    { key: 'interconnect', label: 'Interconnection application', hint: 'Prepared and packaged for filing.' },
    { key: 'ahj', label: 'AHJ permit package', hint: 'Building, electrical and fire submittal set.' }
  ];

  var DEFAULT_CATEGORIES = [
    'Site survey', 'Civil / survey drawings', 'Electrical / one-line',
    'Utility correspondence', 'Parcel & title', 'Site photos',
    'Environmental', 'Equipment cut sheets', 'Permits & approvals',
    'Load data', 'Other'
  ];

  // status key -> { label, client-facing blurb, stage index }
  var STATUS = {
    draft:             { label: 'Draft',             stage: 0, tone: 'muted',  blurb: 'Not submitted yet.' },
    saved:             { label: 'Saved (self-serve)', stage: 0, tone: 'muted',  blurb: 'Kept as your own record. Not sent to Omega.' },
    submitted:         { label: 'Submitted',         stage: 1, tone: 'info',   blurb: 'Received. Waiting to be picked up.' },
    in_review:         { label: 'In review',         stage: 2, tone: 'info',   blurb: 'Reviewing your inputs to price the work.' },
    quoted:            { label: 'Quote sent',        stage: 2, tone: 'warn',   blurb: 'A fee quote is waiting for your approval.' },
    declined:          { label: 'Quote declined',    stage: 2, tone: 'muted',  blurb: 'You declined the quote. The record is still yours.' },
    accepted:          { label: 'Accepted',          stage: 3, tone: 'good',   blurb: 'Quote accepted. Work is scheduled.' },
    changes_requested: { label: 'Needs your input',  stage: 2, tone: 'warn',   blurb: 'Omega needs something from you to continue.' },
    in_production:     { label: 'In production',     stage: 3, tone: 'info',   blurb: 'Drawings and packages are being produced.' },
    delivered:         { label: 'Delivered',         stage: 4, tone: 'good',   blurb: 'Complete. Files are attached below.' }
  };
  var PIPELINE = ['Draft', 'Submitted', 'Quoted', 'In production', 'Delivered'];
  // Statuses a client may set on their own. Mirrors clientStatus() in
  // firestore.rules — keep the two lists in step.
  var CLIENT_STATUS = ['draft', 'saved', 'submitted', 'accepted', 'declined'];

  /* ----------------------------------------------------------------- utils */
  function uid(prefix) {
    return (prefix || 'ix') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }
  function nowIso() { return new Date().toISOString(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normalizeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }
  function linkHost(u) {
    try { return new URL(normalizeUrl(u)).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }
  function linkProvider(u) {
    var h = linkHost(u);
    if (/drive\.google|docs\.google/.test(h)) return 'Google Drive';
    if (/dropbox/.test(h)) return 'Dropbox';
    if (/sharepoint|onedrive|1drv/.test(h)) return 'SharePoint';
    if (/box\.com/.test(h)) return 'Box';
    if (/egnyte|sync\.com|pcloud/.test(h)) return 'File share';
    return h || 'Link';
  }

  /* ---------------------------------------------------------------- record */
  function blankRecord(user) {
    var rec = {
      intakeId: uid('ix'),
      schemaVersion: 1,
      orgId: orgId(),
      tenantKey: tenantKey(),
      tenantName: tenantName(),
      createdBy: {
        uid: (user && user.uid) || null,
        email: (user && user.email) || '',
        name: (user && (user.displayName || user.name)) || ''
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      submittedAt: null,
      completedAt: null,
      /* purpose is the fork the whole tool turns on:
           'build'   — intake the documents and photos, open a project, do the
                       work themselves in the editor. No fee, never quoted.
           'service' — the same intake, but ClearSky produces the deliverables
                       for a fee. Quoted, accepted, then worked.
         routing is kept as the storage-level mirror ('self' / 'omega') so
         records written before the fork existed still read correctly. */
      purpose: 'build',
      routing: 'self',
      status: 'draft',
      /* The tenant's own project in /projects — the same collection the editor
         and the portal project list read. Path 1 creates one from this intake;
         path 2 links to an existing one so the delivered files land against
         the project the customer already has open. */
      editorProjectId: '',
      editorProjectName: '',
      /* Priced by ClearSky, never by the client. Pinned in the rules. */
      quote: { lines: [], subtotal: null, discount: 0, total: null,
               currency: 'USD', note: '', sentAt: null, sentBy: '', expiresAt: null },
      /* Written by the client when they accept or decline. */
      acceptance: { state: '', by: '', at: null, poNumber: '', note: '' },
      customer: {
        company: '', contactName: '', email: '', phone: '', role: '',
        street: '', city: '', state: '', zip: '', notes: ''
      },
      project: {
        name: '', siteName: '', street: '', city: '', state: '', zip: '',
        apn: '', lat: '', lng: '', utility: '', utilityAccount: '', ahj: '',
        stage: 'Feasibility', targetDate: '', siteControl: 'Under evaluation',
        serviceVoltage: '', existingServiceA: '', notes: ''
      },
      scope: {},
      links: [],
      categories: DEFAULT_CATEGORIES.slice(),
      deliverables: DELIVERABLES.map(function (d) {
        return { key: d.key, label: d.label, requested: false, status: 'not_started', outputUrl: '', note: '', updatedAt: null };
      }),
      activity: [],
      messages: [],
      /* Client-reported payment. quote.paymentStatus stays ClearSky's. */
      payment: { claimedAt: null, claimedBy: '', reference: '' },
      admin: { assignee: '', priority: 'normal', internalNotes: '', dueDate: '' },
      notify: { unreadForClient: false, lastNotifiedAt: null, lastMessage: '' }
    };
    SCOPES.forEach(function (s) { rec.scope[s.key] = { enabled: false }; });
    return rec;
  }

  function logActivity(rec, type, message, actor) {
    rec.activity = rec.activity || [];
    rec.activity.unshift({ ts: nowIso(), type: type, message: message, actor: actor || 'system' });
    if (rec.activity.length > 200) rec.activity.length = 200;
    return rec;
  }

  function activeScopes(rec) {
    return SCOPES.filter(function (s) {
      return rec.scope && rec.scope[s.key] && rec.scope[s.key].enabled;
    });
  }
  function requestedDeliverables(rec) {
    return (rec.deliverables || []).filter(function (d) { return d.requested; });
  }

  // Completeness: what still has to be filled in before this can be submitted.
  function validate(rec) {
    var missing = [];
    if (!rec.customer.company) missing.push('Customer company');
    if (!rec.customer.contactName) missing.push('Primary contact name');
    if (!rec.customer.email) missing.push('Contact email');
    if (!rec.project.name) missing.push('Project name');
    if (!rec.project.city || !rec.project.state) missing.push('Site city and state');
    if (!activeScopes(rec).length) missing.push('At least one technology scope');
    if (rec.purpose === 'service' && !requestedDeliverables(rec).length) {
      missing.push('At least one requested deliverable');
    }
    return { ok: missing.length === 0, missing: missing };
  }
  function completeness(rec) {
    var checks = [
      !!rec.customer.company, !!rec.customer.contactName, !!rec.customer.email,
      !!rec.project.name, !!(rec.project.city && rec.project.state),
      !!rec.project.utility, !!rec.project.ahj,
      activeScopes(rec).length > 0,
      (rec.links || []).length > 0,
      requestedDeliverables(rec).length > 0
    ];
    var hit = checks.filter(Boolean).length;
    return Math.round((hit / checks.length) * 100);
  }

  /* ----------------------------------------------------------------- store */
  /* Two backends ship in the box:
   *   'firestore' — used when a Firebase compat Firestore instance is found.
   *   'local'     — localStorage, so the page is fully usable in dev/offline.
   * To wire a modular (v9+) SDK, call OmegaIntake.setBackend({...}) with the
   * same six methods before the page reads any data. See INTAKE-README.md.
   */
  var backend = null;

  function detectFirestore() {
    var c = cfg();
    if (c.firestore) return c.firestore;                              // explicit handoff
    if (global.omegaFirestore) return global.omegaFirestore;
    if (global.firebase && typeof global.firebase.firestore === 'function') {
      try { return global.firebase.firestore(); } catch (e) { return null; }
    }
    return null;
  }

  function makeFirestoreBackend(db) {
    var col = function () { return db.collection(COLLECTION); };
    return {
      name: 'firestore',
      listForOrg: function (org) {
        return col().where('orgId', '==', org).get().then(function (snap) {
          return snap.docs.map(function (d) { return d.data(); });
        });
      },
      listAll: function () {
        return col().get().then(function (snap) {
          return snap.docs.map(function (d) { return d.data(); });
        });
      },
      get: function (id) {
        return col().doc(id).get().then(function (d) { return d.exists ? d.data() : null; });
      },
      save: function (rec) {
        rec.updatedAt = nowIso();
        return col().doc(rec.intakeId).set(rec, { merge: false }).then(function () { return rec; });
      },
      remove: function (id) { return col().doc(id).delete(); },
      watch: function (org, cb) {
        var q = org ? col().where('orgId', '==', org) : col();
        return q.onSnapshot(function (snap) {
          cb(snap.docs.map(function (d) { return d.data(); }));
        });
      }
    };
  }

  function makeLocalBackend() {
    var KEY = 'omega.intake.v1';
    function all() {
      try { return JSON.parse(global.localStorage.getItem(KEY) || '[]'); }
      catch (e) { return []; }
    }
    function put(list) {
      try { global.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
      listeners.forEach(function (fn) { try { fn(all()); } catch (e) {} });
    }
    var listeners = [];
    return {
      name: 'local',
      listForOrg: function (org) {
        return Promise.resolve(all().filter(function (r) { return r.orgId === org; }));
      },
      listAll: function () { return Promise.resolve(all()); },
      get: function (id) {
        return Promise.resolve(all().filter(function (r) { return r.intakeId === id; })[0] || null);
      },
      save: function (rec) {
        rec.updatedAt = nowIso();
        var list = all(), i = -1;
        list.forEach(function (r, n) { if (r.intakeId === rec.intakeId) i = n; });
        if (i > -1) list[i] = rec; else list.push(rec);
        put(list);
        return Promise.resolve(rec);
      },
      remove: function (id) {
        put(all().filter(function (r) { return r.intakeId !== id; }));
        return Promise.resolve();
      },
      watch: function (org, cb) {
        var fn = function (list) {
          cb(org ? list.filter(function (r) { return r.orgId === org; }) : list);
        };
        listeners.push(fn);
        fn(all());
        return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
      }
    };
  }

  function store() {
    if (backend) return backend;
    var db = detectFirestore();
    backend = db ? makeFirestoreBackend(db) : makeLocalBackend();
    return backend;
  }
  function setBackend(b) { backend = b; }

  /* ------------------------------------------------------------ transitions */
  function submit(rec, actor) {
    var v = validate(rec);
    if (!v.ok) return Promise.reject(new Error('Missing: ' + v.missing.join(', ')));
    rec.purpose = 'service';
    rec.routing = 'omega';
    rec.status = 'submitted';
    rec.submittedAt = nowIso();
    logActivity(rec, 'submit', 'Submitted to Omega for ' +
      requestedDeliverables(rec).length + ' deliverable(s).', actor || rec.createdBy.email);
    return store().save(rec);
  }

  function saveSelfServe(rec, actor) {
    rec.purpose = 'build';
    rec.routing = 'self';
    if (rec.status === 'draft') rec.status = 'saved';
    logActivity(rec, 'save', 'Saved as a self-serve record.', actor || rec.createdBy.email);
    return store().save(rec);
  }

  function setStatus(rec, next, actor, note) {
    var prev = rec.status;
    rec.status = next;
    if (next === 'delivered') rec.completedAt = nowIso();
    logActivity(rec, 'status',
      'Status changed from ' + (STATUS[prev] ? STATUS[prev].label : prev) +
      ' to ' + (STATUS[next] ? STATUS[next].label : next) + (note ? ' — ' + note : ''), actor);
    return store().save(rec);
  }

  /* Notify the client. Writes the in-app notification onto the record, then
   * hands off to an optional transport (email/Slack) if one is configured.
   * cfg().intakeNotifyHook may be a function(rec, message) => Promise. */
  function notifyClient(rec, message, actor) {
    rec.notify = rec.notify || {};
    rec.notify.unreadForClient = true;
    rec.notify.lastNotifiedAt = nowIso();
    rec.notify.lastMessage = message || 'Your project package is ready.';
    logActivity(rec, 'notify', 'Client notified: ' + rec.notify.lastMessage, actor);
    var hook = cfg().intakeNotifyHook;
    var after = typeof hook === 'function'
      ? Promise.resolve(hook(clone(rec), rec.notify.lastMessage)).catch(function (e) {
          console.warn('[intake] notify hook failed', e); })
      : Promise.resolve();
    return after.then(function () { return store().save(rec); });
  }

  function acknowledge(rec) {
    if (rec.notify) rec.notify.unreadForClient = false;
    return store().save(rec);
  }

  /* -------------------------------------------------------------- links API */
  function addLink(rec, link, actor) {
    rec.links = rec.links || [];
    var row = {
      id: uid('ln'),
      category: link.category || 'Other',
      label: link.label || linkProvider(link.url) + ' folder',
      url: normalizeUrl(link.url),
      note: link.note || '',
      addedBy: actor || (rec.createdBy && rec.createdBy.email) || '',
      addedByRole: link.addedByRole || 'client',
      addedAt: nowIso()
    };
    rec.links.push(row);
    logActivity(rec, 'link', 'Added link "' + row.label + '" under ' + row.category + '.', row.addedBy);
    return row;
  }
  function updateLink(rec, id, patch, actor) {
    (rec.links || []).forEach(function (l) {
      if (l.id !== id) return;
      var was = l.category;
      Object.keys(patch).forEach(function (k) {
        l[k] = k === 'url' ? normalizeUrl(patch[k]) : patch[k];
      });
      if (patch.category && patch.category !== was) {
        logActivity(rec, 'link', 'Recategorized "' + l.label + '": ' + was + ' → ' + l.category + '.', actor);
      }
    });
  }
  function removeLink(rec, id, actor) {
    var gone = (rec.links || []).filter(function (l) { return l.id === id; })[0];
    rec.links = (rec.links || []).filter(function (l) { return l.id !== id; });
    if (gone) logActivity(rec, 'link', 'Removed link "' + gone.label + '".', actor);
  }
  function addCategory(rec, name) {
    name = String(name || '').trim();
    if (!name) return false;
    rec.categories = rec.categories || DEFAULT_CATEGORIES.slice();
    var exists = rec.categories.some(function (c) {
      return c.toLowerCase() === name.toLowerCase();
    });
    if (exists) return false;
    // keep "Other" last
    var other = rec.categories.indexOf('Other');
    if (other > -1) rec.categories.splice(other, 0, name);
    else rec.categories.push(name);
    return true;
  }

  /* ---------------------------------------------------- projects (path 1) */
  /* The tenant's projects live in /projects — the collection the editor, the
     portal project list and the org rules already share. Intake reads and
     writes that collection directly rather than keeping a parallel copy, so a
     project created here is the same project they open in the editor.

     projectSeed() is the ONE place the field names live. They are inferred
     from the rules (orgId, uid) plus the portal's project cards; if editor.html
     saves under different keys, correct them here and nowhere else. */
  function projectSeed(rec, user) {
    var p = rec.project || {};
    return {
      orgId: orgId(),
      uid: (user && user.uid) || null,
      name: p.name || 'Untitled project',
      address: [p.street, p.city, p.state, p.zip].filter(Boolean).join(', '),
      city: p.city || '', state: p.state || '', zip: p.zip || '',
      lat: p.lat === '' ? null : Number(p.lat),
      lng: p.lng === '' ? null : Number(p.lng),
      apn: p.apn || '',
      utility: p.utility || '',
      ahj: p.ahj || '',
      stage: p.stage || '',
      scopes: activeScopes(rec).map(function (x) { return x.key; }),
      source: 'intake',
      intakeId: rec.intakeId,
      createdBy: (user && user.email) || '',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
  }

  function listProjects(db) {
    if (!db) return Promise.resolve([]);
    return db.collection('projects').where('orgId', '==', orgId()).get()
      .then(function (snap) {
        var out = [];
        snap.forEach(function (d) {
          var v = d.data() || {};
          out.push({ id: d.id, name: v.name || v.title || d.id });
        });
        out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        return out;
      })['catch'](function () { return []; });
  }

  /* Create the project, then point the intake at it. Both directions are
     written: the project carries intakeId, the intake carries the project id,
     so neither side is orphaned if someone opens the other first. */
  function createProject(db, rec, user) {
    if (!db) return Promise.reject(new Error('No Firestore on this page.'));
    var seed = projectSeed(rec, user);
    var ref = db.collection('projects').doc();
    return ref.set(seed).then(function () {
      rec.editorProjectId = ref.id;
      rec.editorProjectName = seed.name;
      logActivity(rec, 'project', 'Opened project "' + seed.name + '" from this intake.',
        (user && user.email) || '');
      return store().save(rec).then(function () { return ref.id; });
    });
  }

  function attachProject(rec, projectId, projectName, actor) {
    rec.editorProjectId = projectId || '';
    rec.editorProjectName = projectName || '';
    if (projectId) logActivity(rec, 'project', 'Linked to project "' + (projectName || projectId) + '".', actor);
    return rec;
  }

  /* ══════════════════════════════════════════════════════════════════
     OMEGA STAFF ROLES

     isAdmin() in the rules is domain-only. That covers ClearSky's own people
     but cannot express "this person is a rep" — and a rep on any other domain
     could not read the queue at all. omega_staff/{uid} fixes that, on the same
     shape as fin_profiles: a person self-creates a PENDING doc on first sign
     in, an administrator promotes it. Nobody grants themselves a role.
     ══════════════════════════════════════════════════════════════════ */
  var STAFF_ROLES = [
    { key: 'none',  label: 'Pending',    blurb: 'Signed in, no access yet.' },
    { key: 'rep',   label: 'Omega Rep',  blurb: 'Works submitted jobs, posts progress, opens them in the editor. Cannot price.' },
    { key: 'admin', label: 'Administrator', blurb: 'Everything a rep can do, plus assigning roles and pricing work.' }
  ];
  function roleLabel(k) {
    for (var i = 0; i < STAFF_ROLES.length; i++) if (STAFF_ROLES[i].key === k) return STAFF_ROLES[i].label;
    return k || 'Pending';
  }

  var _me = null;
  function myStaff() { return _me; }

  /* Reads the caller's own staff doc, creating a pending one if this is their
     first visit. That is what makes a new person show up in the admin list
     without anyone having to add them by hand first. */
  function loadMyStaff(db, user) {
    if (!db || !user || !user.uid) { _me = null; return Promise.resolve(null); }
    var ref = db.collection('omega_staff').doc(user.uid);
    return ref.get().then(function (snap) {
      if (snap.exists) { _me = snap.data(); return _me; }
      var seed = {
        uid: user.uid,
        email: (user.email || '').toLowerCase(),
        name: user.displayName || '',
        role: 'none',
        active: true,
        addedAt: nowIso()
      };
      return ref.set(seed).then(function () { _me = seed; return _me; })
        ['catch'](function () { _me = seed; return _me; });   // rules may refuse; carry on read-only
    })['catch'](function () { _me = null; return null; });
  }

  function listStaff(db) {
    if (!db) return Promise.resolve([]);
    return db.collection('omega_staff').get().then(function (snap) {
      var out = [];
      snap.forEach(function (d) { var v = d.data() || {}; v.uid = v.uid || d.id; out.push(v); });
      out.sort(function (a, b) { return String(a.email).localeCompare(String(b.email)); });
      return out;
    })['catch'](function () { return []; });
  }

  function setStaffRole(db, uid, role, actor) {
    if (!db) return Promise.reject(new Error('No Firestore.'));
    return db.collection('omega_staff').doc(uid).set({
      role: role, updatedAt: nowIso(), updatedBy: actor || ''
    }, { merge: true });
  }
  function setStaffActive(db, uid, active, actor) {
    if (!db) return Promise.reject(new Error('No Firestore.'));
    return db.collection('omega_staff').doc(uid).set({
      active: !!active, updatedAt: nowIso(), updatedBy: actor || ''
    }, { merge: true });
  }

  /* Domain staff are administrators without needing a doc — this mirrors
     isAdmin() in the rules so the UI and the rules agree about who can do
     what. Anything the UI allows that the rules refuse is a bug. */
  var STAFF_DOMAINS = ['clearsky-usa.com', 'csebuilders.com'];
  function isDomainStaff(email) {
    var d = String(email || '').split('@')[1];
    return !!d && STAFF_DOMAINS.indexOf(d.toLowerCase()) >= 0;
  }
  function canWorkQueue(user) {
    if (isDomainStaff(user && user.email)) return true;
    var m = myStaff();
    return !!(m && m.active !== false && (m.role === 'admin' || m.role === 'rep'));
  }
  function canAdminister(user) {
    if (isDomainStaff(user && user.email)) return true;
    var m = myStaff();
    return !!(m && m.active !== false && m.role === 'admin');
  }

  /* ---------------------------------------------------------------- payment */
  /* The payment link lives ON THE QUOTE, not in the admin map: the client has
     to be able to see and click it, and the quote is already the one map they
     can read but not write. Same protection, no extra surface. */
  function setPaymentLink(rec, url, actor) {
    rec.quote = rec.quote || {};
    rec.quote.paymentUrl = normalizeUrl(url);
    rec.quote.paymentStatus = rec.quote.paymentStatus || 'unpaid';
    logActivity(rec, 'payment', 'Payment link posted for ' +
      money(rec.quote.total, rec.quote.currency) + '.', actor);
    return store().save(rec);
  }
  function markPaid(rec, actor, note) {
    rec.quote = rec.quote || {};
    rec.quote.paymentStatus = 'paid';
    rec.quote.paidAt = nowIso();
    logActivity(rec, 'payment', 'Marked paid' + (note ? ' \u2014 ' + note : '') + '.', actor);
    return store().save(rec);
  }

  /* -------------------------------------------------------------- messages
     A two-way thread on the record. Deliberately an array on the document
     rather than a subcollection: both sides already hold read+update on this
     one document, so a thread costs no new rules and no second read.

     `side` is what the reader needs — 'client' or 'omega' — not the role,
     because a rep and an administrator are the same voice to a customer.

     Capped at 300. A Firestore document has a 1 MB ceiling and a thread is
     the one field with no natural bound; losing the oldest note is a far
     better failure than a save that starts rejecting at 1 MB with no
     explanation.                                                            */
  var MSG_CAP = 300;

  function postMessage(rec, text, side, actor) {
    text = String(text || '').trim();
    if (!text) return Promise.reject(new Error('Nothing to send.'));
    rec.messages = rec.messages || [];
    rec.messages.push({
      id: uid('m'),
      at: nowIso(),
      side: (side === 'client') ? 'client' : 'omega',
      by: actor || '',
      byName: actor || '',
      text: text.slice(0, 4000)
    });
    if (rec.messages.length > MSG_CAP) rec.messages = rec.messages.slice(-MSG_CAP);

    /* Flag the OTHER side. A message the sender has to mark unread for
       themselves would be noise. */
    rec.notify = rec.notify || {};
    if (side === 'client') {
      rec.notify.unreadForOmega = true;
    } else {
      rec.notify.unreadForClient = true;
      rec.notify.lastNotifiedAt = nowIso();
      rec.notify.lastMessage = text.slice(0, 240);
    }
    logActivity(rec, 'message',
      (side === 'client' ? 'Client wrote: ' : 'Message to client: ') + text.slice(0, 120), actor);
    return store().save(rec);
  }

  function markMessagesRead(rec, side) {
    rec.notify = rec.notify || {};
    if (side === 'client') rec.notify.unreadForClient = false;
    else rec.notify.unreadForOmega = false;
    return store().save(rec);
  }

  function unreadFor(rec, side) {
    var n = rec.notify || {};
    return side === 'client' ? !!n.unreadForClient : !!n.unreadForOmega;
  }

  /* ------------------------------------------------------- payment (client)
     The client says they have paid; ClearSky confirms the money arrived.

     TWO FIELDS, DELIBERATELY. quote.paymentStatus is pinned to ClearSky by the
     rules, and it should be: the party paying must not be the party who
     records the payment as received. This writes a separate top-level
     `payment` map the client CAN write, which shows up on the ops console as
     "client says they paid" and waits for a human to confirm.

     It is a claim, not a receipt, and the UI on both sides says so.          */
  function claimPayment(rec, actor, reference) {
    rec.payment = rec.payment || {};
    rec.payment.claimedAt = nowIso();
    rec.payment.claimedBy = actor || '';
    rec.payment.reference = String(reference || '').slice(0, 120);
    rec.notify = rec.notify || {};
    rec.notify.unreadForOmega = true;
    logActivity(rec, 'payment', 'Client reported payment sent'
      + (reference ? ' (ref ' + rec.payment.reference + ')' : '') + '.', actor);
    return store().save(rec);
  }

  /* Where the money actually stands, in one place, so three pages don't each
     invent their own precedence. */
  function paymentState(rec) {
    var q = rec.quote || {}, p = rec.payment || {};
    if (q.paymentStatus === 'paid') return { key:'paid',     label:'Paid',              at:q.paidAt };
    if (p.claimedAt)                return { key:'claimed',  label:'Payment reported',  at:p.claimedAt };
    if (q.paymentUrl)               return { key:'due',      label:'Payment due',       at:null };
    if (typeof q.total === 'number')return { key:'awaiting', label:'Awaiting a payment link', at:null };
    return { key:'none', label:'', at:null };
  }

  /* Standard quote rungs. Two people pricing the same job should land on the
     same number; `custom` stays available for the jobs that genuinely are. */
  var QUOTE_TIERS = [100, 250, 500, 750, 1000];

  /* ------------------------------------------------------- quoting (path 2) */
  /* NO DEFAULT PRICES SHIP IN THIS FILE, deliberately. A fabricated number in
     a customer-facing quote is worse than a blank one — the client either pays
     a made-up figure or catches it and stops trusting the tool. A rate card is
     read from omega_orgs/{orgId}.priceBook when one exists; where it does not,
     the client sees "Quoted after review" and a person prices it. */
  function priceBook() {
    var b = brand();
    return (b && b.priceBook) || {};
  }
  function listPrice(key) {
    var v = priceBook()[key];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  /* Estimate shown to the client BEFORE a quote exists. Returns null when any
     requested deliverable has no rate — a partial total reads as the whole
     price, which is the misleading half of showing a number at all. */
  function estimate(rec) {
    var req = requestedDeliverables(rec);
    if (!req.length) return null;
    var sum = 0;
    for (var i = 0; i < req.length; i++) {
      var p = listPrice(req[i].key);
      if (p === null) return null;
      sum += p;
    }
    return sum;
  }
  function quoteTotal(rec) {
    var q = rec.quote || {};
    return (typeof q.total === 'number') ? q.total : null;
  }
  function money(n, cur) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try {
      return n.toLocaleString(undefined, { style: 'currency', currency: cur || 'USD',
        maximumFractionDigits: 0 });
    } catch (e) { return (cur || 'USD') + ' ' + Math.round(n); }
  }

  /* Build the quote from the requested deliverables so a line can never be
     billed for work that was not asked for. */
  function draftQuoteLines(rec) {
    return requestedDeliverables(rec).map(function (d) {
      var existing = ((rec.quote && rec.quote.lines) || []).filter(function (l) {
        return l.key === d.key;
      })[0];
      return {
        key: d.key,
        label: d.label,
        amount: existing ? existing.amount : listPrice(d.key),
        note: existing ? existing.note : ''
      };
    });
  }
  function recalcQuote(rec) {
    var q = rec.quote = rec.quote || {};
    var sum = 0, complete = true;
    (q.lines || []).forEach(function (l) {
      if (typeof l.amount === 'number' && isFinite(l.amount)) sum += l.amount;
      else complete = false;
    });
    q.subtotal = complete ? sum : null;
    q.total = complete ? Math.max(0, sum - (Number(q.discount) || 0)) : null;
    return q;
  }
  function sendQuote(rec, actor) {
    recalcQuote(rec);
    if (rec.quote.total === null) {
      return Promise.reject(new Error('Every line needs an amount before the quote goes out.'));
    }
    rec.quote.sentAt = nowIso();
    rec.quote.sentBy = actor || '';
    rec.status = 'quoted';
    rec.acceptance = { state: '', by: '', at: null, poNumber: '', note: '' };
    logActivity(rec, 'quote', 'Quote sent: ' +
      money(rec.quote.total, rec.quote.currency) + ' for ' +
      (rec.quote.lines || []).length + ' deliverable(s).', actor);
    return store().save(rec);
  }
  function acceptQuote(rec, actor, poNumber) {
    if (rec.status !== 'quoted') {
      return Promise.reject(new Error('There is no open quote to accept.'));
    }
    rec.acceptance = { state: 'accepted', by: actor || '', at: nowIso(),
                       poNumber: poNumber || '', note: '' };
    rec.status = 'accepted';
    logActivity(rec, 'quote', 'Quote accepted' +
      (poNumber ? ' (PO ' + poNumber + ')' : '') + '.', actor);
    return store().save(rec);
  }
  function declineQuote(rec, actor, why) {
    if (rec.status !== 'quoted') {
      return Promise.reject(new Error('There is no open quote to decline.'));
    }
    rec.acceptance = { state: 'declined', by: actor || '', at: nowIso(),
                       poNumber: '', note: why || '' };
    rec.status = 'declined';
    logActivity(rec, 'quote', 'Quote declined' + (why ? ': ' + why : '') + '.', actor);
    return store().save(rec);
  }

  /* --------------------------------------------------------------- exports */
  global.OmegaIntake = {
    COLLECTION: COLLECTION,
    SCOPES: SCOPES,
    DELIVERABLES: DELIVERABLES,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    STATUS: STATUS,
    PIPELINE: PIPELINE,

    cfg: cfg, orgId: orgId, setOrg: setOrg, orgAlias: orgAlias,
    tenantKey: tenantKey, tenantName: tenantName, brand: brand, loadBrand: loadBrand,
    currentEmail: currentEmail, returnUrl: returnUrl,
    editorUrl: editorUrl, adminOrigin: adminOrigin, serviceName: serviceName,

    blankRecord: blankRecord, validate: validate, completeness: completeness,
    activeScopes: activeScopes, requestedDeliverables: requestedDeliverables,
    logActivity: logActivity,

    submit: submit, saveSelfServe: saveSelfServe, setStatus: setStatus,
    notifyClient: notifyClient, acknowledge: acknowledge,

    addLink: addLink, updateLink: updateLink, removeLink: removeLink,
    addCategory: addCategory, linkProvider: linkProvider, normalizeUrl: normalizeUrl,

    STAFF_ROLES: STAFF_ROLES, roleLabel: roleLabel,
    myStaff: myStaff, loadMyStaff: loadMyStaff, listStaff: listStaff,
    setStaffRole: setStaffRole, setStaffActive: setStaffActive,
    isDomainStaff: isDomainStaff, canWorkQueue: canWorkQueue, canAdminister: canAdminister,
    setPaymentLink: setPaymentLink, markPaid: markPaid,
    postMessage: postMessage, markMessagesRead: markMessagesRead, unreadFor: unreadFor,
    claimPayment: claimPayment, paymentState: paymentState, QUOTE_TIERS: QUOTE_TIERS,
    projectSeed: projectSeed, listProjects: listProjects,
    createProject: createProject, attachProject: attachProject,
    priceBook: priceBook, listPrice: listPrice, estimate: estimate,
    quoteTotal: quoteTotal, money: money, draftQuoteLines: draftQuoteLines,
    recalcQuote: recalcQuote, sendQuote: sendQuote,
    acceptQuote: acceptQuote, declineQuote: declineQuote,
    CLIENT_STATUS: CLIENT_STATUS,
    store: store, setBackend: setBackend,
    uid: uid, nowIso: nowIso, clone: clone
  };
})(window);
