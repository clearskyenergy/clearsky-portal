/* ============================================================
   ClearSky OMEGA — Shared Telemetry Gate + Integration Catalog
   ------------------------------------------------------------
   ONE file, loaded by all five O&M tools AND by OMEGA Signal
   (the account/integrations console). It is the single source of
   truth for:
     1. INTEGRATION_CATALOG — every provider + its fields. Add a
        provider here ONCE and every tool + Signal picks it up.
     2. hasTelemetry()      — has this org connected any telemetry
        source? Tools use it to decide: show real data, or show the
        "Connect your sources in OMEGA Signal" empty state.
     3. signalUrl()         — canonical deep link to OMEGA Signal,
        org-scoped, so every tool links to the same place.
     4. renderConnectFirst()— the standard empty-state HTML.

   Hosted at https://tools.csebuilders.com/om-telemetry-gate.js
   ES5-only, no build step. Attaches to window.OMEGASignal.
   Cache-bust with ?v=N in each tool's <script> when you update it.
   ============================================================ */
(function (root) {
  "use strict";

  var SIGNAL_KEY = "signal";                 // OMEGA Signal app key
  var SIGNAL_FILE = "/account-settings.html"; // Signal's hosted file
  var TOOL_HOST = "https://tools.csebuilders.com";

  /* ---- provider catalog (mirrors what Signal renders) ----
     feeds: "telemetry" = pulls data INTO om_sites/fc_assets/sla_events
            "tickets"   = pushes/pulls work orders (fs_*, om_tickets)
            "alerts"    = outbound notifications (Slack/SMS)
     Only "telemetry" providers count toward hasTelemetry(). */
  var INTEGRATION_CATALOG = {
    powerfactors:  { group:"Monitoring", label:"Power Factors (Drive)", color:"#1461d2", feeds:"telemetry", fields:[
      { key:"apiKey", label:"API Key", secret:true } ], note:"Asset performance / DAS aggregation." },
    also:          { group:"Monitoring", label:"AlsoEnergy / PowerTrack", color:"#e08600", feeds:"telemetry", fields:[
      { key:"apiKey", label:"API Key", secret:true },
      { key:"siteId", label:"Site ID" } ], note:"Solar + storage monitoring." },
    solaredge:     { group:"Monitoring", label:"SolarEdge Monitoring", color:"#e2241a", feeds:"telemetry", fields:[
      { key:"apiKey", label:"API Key", secret:true } ], note:"Inverter-level production." },
    fronius:       { group:"Monitoring", label:"Fronius Solar.web", color:"#0d7d72", feeds:"telemetry", fields:[
      { key:"accessKeyId", label:"Access Key ID" },
      { key:"accessKeyValue", label:"Access Key Value", secret:true } ], note:"Inverter telemetry." },
    gotion_ems:    { group:"Monitoring", label:"Gotion / Molecule EMS", color:"#6b3fd4", feeds:"telemetry", fields:[
      { key:"endpoint", label:"EMS Endpoint URL", ph:"https://ems.molecule…" },
      { key:"token", label:"Bearer Token", secret:true } ], note:"BESS SoC, dispatch, availability." },
    modbus_gw:     { group:"Monitoring", label:"Generic Modbus/SunSpec Gateway", color:"#5b6b7c", feeds:"telemetry", fields:[
      { key:"endpoint", label:"Gateway URL" },
      { key:"apiKey", label:"API Key", secret:true } ], note:"On-site datalogger bridge." },
    servicenow:    { group:"Field Service", label:"ServiceNow", color:"#137a44", feeds:"tickets", fields:[
      { key:"instanceUrl", label:"Instance URL", ph:"https://yourco.service-now.com" },
      { key:"clientId", label:"Client ID", secret:true },
      { key:"clientSecret", label:"Client Secret", secret:true } ], note:"Enterprise work-order sync." },
    servicetitan:  { group:"Field Service", label:"ServiceTitan", color:"#e2241a", feeds:"tickets", fields:[
      { key:"clientId", label:"Client ID", secret:true },
      { key:"clientSecret", label:"Client Secret", secret:true },
      { key:"tenantId", label:"Tenant ID" } ], note:"Dispatch & technician scheduling." },
    monday_wo:     { group:"Field Service", label:"Monday.com (Work Orders)", color:"#ff3d57", feeds:"tickets", fields:[
      { key:"apiToken", label:"API Token", secret:true } ], note:"Board-based ticket sync." },
    slack:         { group:"Alerts", label:"Slack", color:"#4a154b", feeds:"alerts", fields:[
      { key:"webhookUrl", label:"Incoming Webhook URL", secret:true } ], note:"Post P1 tickets & SLA-at-risk alerts." },
    twilio:        { group:"Alerts", label:"Twilio SMS", color:"#f22f46", feeds:"alerts", fields:[
      { key:"accountSid", label:"Account SID" },
      { key:"authToken", label:"Auth Token", secret:true },
      { key:"fromNumber", label:"From Number", ph:"+1…" } ], note:"On-call SMS for critical tickets." }
  };

  function catalog(){ return INTEGRATION_CATALOG; }
  function telemetryProviders(){ var o={}; for(var k in INTEGRATION_CATALOG){ if(INTEGRATION_CATALOG[k].feeds==="telemetry") o[k]=INTEGRATION_CATALOG[k]; } return o; }

  /* Canonical OMEGA Signal deep link (org-scoped). If the tool
     registry has a custom URL for this org, callers can override. */
  function signalUrl(orgId){ return TOOL_HOST + SIGNAL_FILE + (orgId ? ("?org=" + encodeURIComponent(orgId)) : ""); }
  function signalKey(){ return SIGNAL_KEY; }

  /* Read the org's non-secret integration status doc and decide
     whether ANY telemetry source is connected. Returns a Promise
     that resolves to a summary object — never rejects (defaults to
     "no telemetry" on error so tools fail safe to the empty state). */
  function readStatus(db, orgId){
    try{
      return db.collection("om_integrations").doc(orgId).get().then(function(d){
        var data = (d && d.exists) ? (d.data()||{}) : {};
        var providers = data.providers || data.connected || {};
        var telemetry = 0, tickets = 0, alerts = 0, total = 0;
        for(var k in providers){
          var p = providers[k]; var isConn = p===true || (p && p.connected);
          if(!isConn) continue;
          total++;
          var meta = INTEGRATION_CATALOG[k];
          if(meta){ if(meta.feeds==="telemetry")telemetry++; else if(meta.feeds==="tickets")tickets++; else if(meta.feeds==="alerts")alerts++; }
        }
        return { hasTelemetry: telemetry>0, telemetry:telemetry, tickets:tickets, alerts:alerts, total:total, siteMap:data.siteMap||{}, raw:data };
      }).catch(function(){ return { hasTelemetry:false, telemetry:0, tickets:0, alerts:0, total:0, siteMap:{}, raw:{} }; });
    }catch(e){
      return Promise.resolve({ hasTelemetry:false, telemetry:0, tickets:0, alerts:0, total:0, siteMap:{}, raw:{} });
    }
  }

  /* Standard "connect your sources first" empty-state HTML.
     toolLabel e.g. "the O&M Console"; orgId for the deep link. */
  function connectFirstHTML(toolLabel, orgId){
    var url = signalUrl(orgId);
    return ''
      + '<div class="card"><div class="card-b" style="text-align:center;padding:48px 24px;max-width:620px;margin:0 auto">'
      +   '<div style="font-size:42px;line-height:1">📡</div>'
      +   '<h3 style="margin:14px 0 6px;font-size:18px">Connect your data sources to get started</h3>'
      +   '<p class="muted" style="font-size:14px;max-width:460px;margin:0 auto 18px">'
      +     (toolLabel||"This tool") + ' runs on live telemetry from your monitoring, EMS, and ticketing systems. '
      +     'Connect them once in <b>OMEGA Signal</b> and data flows into every OMEGA operations tool automatically.'
      +   '</p>'
      +   '<a href="'+url+'" class="btn pri" style="text-decoration:none;display:inline-flex;padding:10px 18px">Open OMEGA Signal →</a>'
      +   '<div class="muted" style="font-size:12px;margin-top:14px">Already connected? Give the first sync a minute, then reload.</div>'
      + '</div></div>';
  }

  root.OMEGASignal = {
    catalog: catalog,
    telemetryProviders: telemetryProviders,
    signalUrl: signalUrl,
    signalKey: signalKey,
    readStatus: readStatus,
    connectFirstHTML: connectFirstHTML,
    SIGNAL_FILE: SIGNAL_FILE
  };

})(typeof window !== "undefined" ? window : this);
