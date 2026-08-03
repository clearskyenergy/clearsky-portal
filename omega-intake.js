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
    in_review:         { label: 'In review',         stage: 2, tone: 'info',   blurb: 'Omega is reviewing your inputs.' },
    changes_requested: { label: 'Needs your input',  stage: 2, tone: 'warn',   blurb: 'Omega needs something from you to continue.' },
    in_production:     { label: 'In production',     stage: 3, tone: 'info',   blurb: 'Drawings and packages are being produced.' },
    delivered:         { label: 'Delivered',         stage: 4, tone: 'good',   blurb: 'Complete. Files are attached below.' }
  };
  var PIPELINE = ['Draft', 'Submitted', 'In review', 'In production', 'Delivered'];

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
      routing: 'omega',            // 'omega' = do it for me | 'self' = record only
      status: 'draft',
      editorProjectId: '',
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
    if (rec.routing === 'omega' && !requestedDeliverables(rec).length) {
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
    rec.routing = 'omega';
    rec.status = 'submitted';
    rec.submittedAt = nowIso();
    logActivity(rec, 'submit', 'Submitted to Omega for ' +
      requestedDeliverables(rec).length + ' deliverable(s).', actor || rec.createdBy.email);
    return store().save(rec);
  }

  function saveSelfServe(rec, actor) {
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

    store: store, setBackend: setBackend,
    uid: uid, nowIso: nowIso, clone: clone
  };
})(window);
