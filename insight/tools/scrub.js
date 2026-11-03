"use strict";
// Scrub real gesys rows before they are committed as fixtures (§12 item 9).
// Keeps what rules read (process, message, exception_class, severity,
// ermes_number); replaces identifiers that could point at a site/patient.
function scrub_type(type) {
  const t = type || "";
  const i = t.indexOf("\t");
  return i >= 0 ? `HOST\t${t.slice(i + 1)}` : t;
}
function scrub_message(msg) {
  return (msg || "")
    .replace(/((?:Prospective\s+)?Exam(?:\s+Number)?\s*[:=]?\s*|\bexam\s+|exam=)(\d+)/gi, "$110001")
    .replace(/\bE\d+(?=\/S\d)/g, "E10001") // GE image notation E<exam>/S<series>/I<image>
    .replace(/host_id:\s*\d+/gi, "host_id: 0")
    .replace(/\bhost\s*=\s*'[^']*'/gi, "host='HOST'")
    .replace(/^(\s*(?:Start Sending|Sent):[^(\n]*)\([^)]*\)/m, "$1(DEST)")
    .replace(/\b\d+(?:\.\d+){4,}\b/g, "1.2.3.4.5") // DICOM UIDs (before the IPv4 rule)
    .replace(/(?<![\d.])(\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "0.0.0.0"); // IPv4 only, not inside longer dotted numbers
}
function scrub_row(r) {
  return {
    type: scrub_type(r.type),
    message: scrub_message(r.message),
    exception_class: r.exception_class ?? null,
    severity: r.severity ?? null,
    ermes_number: r.ermes_number ?? null,
  };
}
module.exports = { scrub_row, scrub_message, scrub_type };
