"use strict";
// GE MRI code labels (PLAN-MRI-INSIGHTS.md §5.3 Q-M8, §8): a message ->
// its masked template, the masking agreed in MRI-2a (the evidence scripts
// inv.js mask() + gen_doc.js scrub), in one place. The label of a code is
// its most common template; no message text is stored anywhere else.
//
// Masked: every host name seen in log.ge_mri_gesys `type` (on word
// boundaries, any case) -> <host>; MAC -> <mac>; serials; IPv4 -> <ip>;
// 0x-hex and every digit run -> #; GE's date formats -> <date>; DICOM AE
// titles / remote hosts in the known phrases -> <ae>; the ARS device line;
// the JVM log prefix. Line breaks (real or a literal backslash-n) -> ' | ',
// then runs of whitespace -> one space, before any phrase is matched.
// Text is made ASCII first (each non-ASCII character -> '?') so the SQL
// check (verify_derive.js) means the same by \s, word boundaries and the
// 200-character cut. verify_derive.js rewrites this independently in
// PostgreSQL regexes.
//
// Nothing in the GE CT or CV run loads this file.

const LABEL_VERSION = 2; // 2: whitespace collapsed before the phrase masks
const LABEL_MAX = 200;
const MIN_HOST = 3; // shorter "hosts" would mask ordinary words

const ascii = (s) => String(s ?? "").replace(/[^\x00-\x7F]/gu, "?");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Hosts -> one case-insensitive regex, longest first (so the longest name
// wins where one host name starts another), or null.
function host_regex(hosts) {
  const list = [...new Set((hosts || []).map((h) => String(h ?? "").trim()).filter((h) => h.length >= MIN_HOST))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return list.length ? new RegExp(`(?<![A-Za-z0-9_])(${list.map(esc).join("|")})(?![A-Za-z0-9_])`, "gi") : null;
}

const MON = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";

// message -> template ('' when nothing is left).
function template(message, host_re) {
  let m = ascii(message);
  m = m.replace(/\\n|\\r|\r\n|\n|\r/g, " | ");
  // Collapse whitespace BEFORE the phrase masks, which expect single spaces:
  // AE titles framed by double spaces / line breaks slipped through
  // otherwise (review MRI3-DERIVE P2-2 follow-up, found by the extended check E).
  m = m.replace(/\s+/g, " ");
  if (host_re) m = m.replace(host_re, "<host>");
  m = m.replace(/\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "<mac>");
  m = m.replace(/SERIAL=\S+/g, "SERIAL=<serial>");
  m = m.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>");
  m = m.replace(/0x[0-9a-fA-F]+/g, "#");
  m = m.replace(/\d+/g, "#");
  m = m.replace(new RegExp(`\\b(${DAY}) (${MON}) # #:#:# [A-Z]{3} #`, "g"), "<date>");
  m = m.replace(new RegExp(`\\b(${MON}) #, # #:#:# [AP]M\\b`, "g"), "<date>");
  m = m.replace(new RegExp(`\\b(${DAY}) #/#/# #:#:#\\.# [AP]M [A-Z]{3}`, "g"), "<date>");
  m = m.replace(/push failed: \S+ could not perform/g, "push failed: <ae> could not perform");
  m = m.replace(/Message received from \S+ -/g, "Message received from <ae> -");
  m = m.replace(/Operation timed out \[[^\]]*\]/g, "Operation timed out [<ae>]");
  m = m.replace(/No Route to [^.]+\./g, "No Route to <ae>.");
  m = m.replace(/Network session creation for \S+/g, "Network session creation for <ae>");
  m = m.replace(/(Association was rejected from|ECHO was received from|rejected by the remote host) (?:\| )*[^\s.|]+/g, "$1 <ae>");
  m = m.replace(/Resetting ARS \S+ - .*$/, "Resetting ARS <device> - <build>");
  m = m.replace(/host: \S+:/gi, "host <host>:");
  m = m.replace(/^<date> com\.ge\.[A-Za-z0-9_.$]+ [A-Za-z0-9_]+(\s*\|)?\s*/, "");
  m = m.replace(/(\s*\|\s*)+/g, " | ").replace(/\s+/g, " ").replace(/^[\s|]+|[\s|]+$/g, "");
  return m.slice(0, LABEL_MAX);
}

module.exports = { template, host_regex, ascii, LABEL_VERSION, LABEL_MAX, MIN_HOST };
