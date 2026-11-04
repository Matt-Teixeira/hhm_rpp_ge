"use strict";
// Text report of findings per rule, with the evidence that opened each one
// and its last trip (for the §14.4 review). Pure.
const { finding_rules, rank } = require("./rules");

const ev_line = {
  tube_rotor_instability: (e) => `${e.variants.join("+")}: weekly stops ${e.weeks.map((w) => w.rotor_stops).reverse().join(", ")} (oldest..this week); not-at-speed ${e.weeks.map((w) => w.rotor_not_at_speed).reverse().join(", ")}; baseline median ${e.baseline_median} over ${e.baseline_weeks_with_data} weeks [${e.baseline_week_stops.join(", ")}]`,
  process_restart_loop: (e) => `${e.process}: ${e.restarts} restarts that day; ${e.processes.map((p) => `${p.process} ${p.n}`).join(", ")}`,
  abort_rate_high: (e) => `${e.variants.join("+")}: 28d ${e.d28.aborts}/${e.d28.exams} exams = ${e.d28.per_100}/100 (aborts on ${e.d28.days_with_aborts} days); 7d ${e.d7.aborts}/${e.d7.exams} = ${e.d7.per_100} (${e.d7.days_with_aborts} days); 8w baseline ${e.baseline_8w.aborts}/${e.baseline_8w.exams} = ${e.baseline_8w.per_100}; top ermes ${e.top_ermes_28d.map((c) => `${c.code}×${c.n}`).join(", ")}`,
  safe_state_recurrent: (e) => `codes ${e.codes.map((c) => `${c.code}: ${c.incidents} incidents/${c.events} events`).join(", ")}${e.other_codes.length ? `; others ${e.other_codes.map((c) => `${c.code} ${c.incidents}/${c.events}`).join(", ")}` : ""}; excluded in 7d: slip-ring ${e.excluded_7d.code}, near boot/shutdown ${e.excluded_7d.power_cycle}, no code ${e.excluded_7d.no_code}`,
  prep_noncompliance: (e) => `${e.scan_days_without_fast_cal} of ${e.scan_days} scan days without Fast Cal`,
  tube_replaced: (e) => `${e.confidence}, install ${e.install_date}, reset ${e.reset_day}, old tube ${e.old_tube_mas} mA·s, source ${e.tube_source}, ${e.calibrations_in_window} calibrations; resolved by ${e.resolved_by}`,
  warmup_bypass_habit: (e) => `${e.scan_days_with_bypass} of ${e.scan_days} scan days (skipped warm-up ${e.with_skipped_warmup}, warm-up zone ${e.with_warmup_zone_scan})`,
  powered_off_without_shutdown: (e) => `unclean boots ${e.unclean_boots.map((t) => t.slice(0, 16).replace("T", " ")).join(", ")} (UTC); excluded after service mode ${e.excluded_service_mode}`,
  air_calibration_overdue: (e) => `days ${e.days.join(", ")}`,
};
const env_line = (e) => `days ${e.days.join(", ")}; ${e.events_7d} events${e.by_metric ? `; ${Object.entries(e.by_metric).map(([k, v]) => `${k} ${v.days}d/${v.events}`).join(", ")}` : ""}`;

function format_report(rows, { today, scope } = {}) {
  const out = [];
  out.push(`Findings replay as of ${today || "?"} (${scope || "scope not given"}): ${rows.length} findings, ${rows.filter((r) => r.status === "open").length} open`);
  for (const rule of finding_rules) {
    const rs = rows.filter((r) => r.finding_key === rule.key)
      .sort((a, b) => rank(b.severity) - rank(a.severity) || (a.system_id < b.system_id ? -1 : a.system_id > b.system_id ? 1 : a.opened_at < b.opened_at ? -1 : 1));
    const sev = {};
    for (const r of rs) sev[r.severity] = (sev[r.severity] || 0) + 1;
    out.push("", `== ${rule.key} (${rule.label}): ${rs.length} findings, ${rs.filter((r) => r.status === "open").length} open ${JSON.stringify(sev)}`);
    out.push(`   rule: ${rule.description}`);
    const line = ev_line[rule.key] || env_line;
    for (const r of rs) {
      const e = r.evidence;
      const span = `${e.opened_day} -> ${e.resolved_day || `open (data through ${r.data_through})`}`;
      if (rule.kind === "event") { out.push(`  ${r.system_id} ${r.severity.padEnd(6)} ${span}: ${line(e)}`); continue; }
      out.push(`  ${r.system_id} ${r.severity.padEnd(6)} ${span}; ${e.trip_days} trip days, last ${e.last_trip_day}${e.severity_history.length > 1 ? `; severity ${e.severity_history.map((h) => `${h.severity}@${h.day}`).join(" ")}` : ""}`);
      out.push(`      opened: ${line(e.first)}`);
      if (e.last.day !== e.first.day) out.push(`      last:   ${line(e.last)}`);
    }
  }
  return out.join("\n");
}

module.exports = { format_report };
