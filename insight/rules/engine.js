"use strict";
// Pure rule engine (PLAN-CT-INSIGHTS.md §2): (row) -> facts[]. No DB, no clock.

const CATEGORIES = ["utilization", "tube", "reliability", "compliance", "environment", "inventory"];
const VALUE_KINDS = ["event", "gauge", "counter", "text"];
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/; // same as insight.metric_catalog CHECK

// type is "<hostname>\t<process>"; the process is the useful half.
function process_of(type) {
  const t = type || "";
  const i = t.indexOf("\t");
  return (i >= 0 ? t.slice(i + 1) : t).trim();
}

function validate_rules(rules) {
  const errors = [];
  const seen = new Set();
  for (const r of rules) {
    if (!KEY_RE.test(r.key || "")) errors.push(`${r.key}: key does not match ${KEY_RE}`);
    if (seen.has(r.key)) errors.push(`${r.key}: duplicate key`);
    seen.add(r.key);
    if (!Number.isInteger(r.version) || r.version < 1) errors.push(`${r.key}: version must be a positive integer`);
    if (!CATEGORIES.includes(r.category)) errors.push(`${r.key}: bad category ${r.category}`);
    if (!VALUE_KINDS.includes(r.value_kind)) errors.push(`${r.key}: bad value_kind ${r.value_kind}`);
    if (!r.label) errors.push(`${r.key}: label required`);
    if (typeof r.extract !== "function") errors.push(`${r.key}: extract must be a function`);
    if (r.process !== null && r.process !== undefined && !Array.isArray(r.process)) errors.push(`${r.key}: process must be null or an array`);
  }
  return errors;
}

// Returns { facts, errors }. A throwing rule is reported, never fatal.
function facts_for_row(row, rules) {
  const proc = process_of(row.type);
  const input = { ...row, process: proc };
  const facts = [];
  const errors = [];
  for (const r of rules) {
    if (r.process && !r.process.includes(proc)) continue;
    let out;
    try {
      out = r.extract(input);
    } catch (e) {
      errors.push({ key: r.key, id: row.id, error: e.message });
      continue;
    }
    if (!out) continue;
    facts.push({
      metric_key: r.key,
      rule_version: r.version,
      value_num: out.value_num === undefined || Number.isNaN(out.value_num) ? null : out.value_num,
      value_text: out.value_text === undefined ? null : out.value_text,
      exam_no: out.exam_no === undefined ? null : out.exam_no,
      attrs: out.attrs === undefined ? null : out.attrs,
    });
  }
  return { facts, errors };
}

// Rows for insight.metric_catalog, generated from the registry.
function catalog_rows(rules) {
  return rules.map((r) => ({
    metric_key: r.key,
    label: r.label,
    unit: r.unit || null,
    category: r.category,
    value_kind: r.value_kind,
    description: r.description || null,
    customer_visible: r.customer_visible !== false,
    model_specific: r.model_specific === true,
    rule_version: r.version,
  }));
}

module.exports = { facts_for_row, catalog_rows, validate_rules, process_of, CATEGORIES, VALUE_KINDS };
