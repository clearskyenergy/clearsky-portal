/* provider -> feeds map, mirrors om-telemetry-gate.js catalog.
   Keep in sync when you add providers. Used by the proxy to
   recompute hasTelemetry on the status doc. */
module.exports = {
  powerfactors: "telemetry",
  also: "telemetry",
  solaredge: "telemetry",
  fronius: "telemetry",
  gotion_ems: "telemetry",
  modbus_gw: "telemetry",
  servicenow: "tickets",
  servicetitan: "tickets",
  monday_wo: "tickets",
  slack: "alerts",
  twilio: "alerts",
};
