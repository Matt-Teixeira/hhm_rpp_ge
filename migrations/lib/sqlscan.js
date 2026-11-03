"use strict";
// Static safety scan for migration SQL (PLAN-CT-INSIGHTS.md §10, rule 3).
//
// Whitelist, not blacklist: every top-level statement must match a known
// form whose write target is inside the allowed scope (insight.* or
// api.ge_ct_*). Anything unrecognised is refused. Dollar-quoted bodies
// (functions) are scanned for write verbs too, including dynamic SQL in
// format() literals. This is defence in depth: the runner's catalog
// post-check is the authoritative guard on protected objects.

// `%I`/`%s` (format() placeholders) are accepted as identifiers so dynamic
// SQL can be scanned; isAllowedTarget only permits them after `insight.`.
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$%]*|%[Is][A-Za-z0-9_%]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

// ---------------------------------------------------------------- lexing

// Remove comments and split into top-level statements, respecting
// '...', E'...', "...", and $tag$...$tag$ quoting. Returns
// [{ sql, line }] with comments stripped and whitespace normalised later.
function splitStatements(src) {
  const out = [];
  let buf = "";
  let line = 1;
  let stmtLine = null;
  let i = 0;
  const n = src.length;
  const push = () => {
    const sql = buf.trim();
    if (sql) out.push({ sql, line: stmtLine });
    buf = "";
    stmtLine = null;
  };
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c === "\n") line++;
    // line comment
    if (c2 === "--") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // block comment (nestable in PG)
    if (c2 === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "\n") line++;
        if (src.slice(i, i + 2) === "/*") { depth++; i += 2; continue; }
        if (src.slice(i, i + 2) === "*/") { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) throw new ScanError("unterminated block comment", line);
      buf += " ";
      continue;
    }
    if (stmtLine === null && !/\s/.test(c)) stmtLine = line;
    // quoted string / identifier
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\n") line++;
        if (src[j] === q) {
          if (src[j + 1] === q) { j += 2; continue; } // doubled quote
          break;
        }
        if (q === "'" && src[j] === "\\" && /[eE]/.test(src[i - 1] || "")) { j += 2; continue; }
        j++;
      }
      if (j >= n) throw new ScanError(`unterminated ${q === "'" ? "string" : "identifier"}`, line);
      buf += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // dollar quote
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end < 0) throw new ScanError(`unterminated dollar quote ${tag}`, line);
        const body = src.slice(i, end + tag.length);
        line += (body.match(/\n/g) || []).length;
        buf += body;
        i = end + tag.length;
        continue;
      }
    }
    if (c === ";") { push(); i++; continue; }
    buf += c;
    i++;
  }
  push();
  return out;
}

class ScanError extends Error {
  constructor(msg, line) {
    super(line ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

// Replace string literals and dollar bodies with placeholders so the
// top-level grammar checks don't see their contents. Returns
// { shape, literals: [...], bodies: [...] }.
function mask(sql) {
  const bodies = [];
  const literals = [];
  let shape = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      literals.push(sql.slice(i + 1, j));
      shape += " '' ";
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        bodies.push(sql.slice(i + m[0].length, end));
        shape += " $body$ ";
        i = end + m[0].length;
        continue;
      }
    }
    shape += c;
    i++;
  }
  return { shape: shape.replace(/\s+/g, " ").trim(), literals, bodies };
}

// ----------------------------------------------------------- name rules

function normName(q) {
  return q.replace(/\s+/g, "").replace(/"/g, "").toLowerCase();
}

function schemaOf(name) {
  const parts = name.split(".");
  return parts.length >= 2 ? parts[0] : null;
}

// Allowed write scope. `%I`/`%s` placeholders are allowed only in the
// object part of an insight.* name (dynamic partition creation).
function isAllowedTarget(name) {
  const n = normName(name);
  if (/^insight\.(?:[a-z_][a-z0-9_%]*|%[is][a-z0-9_%]*)$/.test(n)) return true;
  if (/^insight\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(n)) return true; // insight.table.column (COMMENT ON COLUMN)
  if (/^api\.ge_ct_[a-z0-9_]*$/.test(n)) return true;
  if (/^api\.ge_ct_[a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(n)) return true;
  return false;
}

// Functions/statements that must never appear, at any level.
const FORBIDDEN_ANYWHERE = [
  /\bpg_terminate_backend\b/i, /\bpg_cancel_backend\b/i, /\bdblink\w*\b/i,
  /\blo_import\b/i, /\blo_export\b/i, /\bpg_read_(binary_)?file\b/i,
  /\bpg_ls_dir\b/i, /\bset_config\b/i, /\bpg_reload_conf\b/i,
  /\bCOPY\b[^;]*\bPROGRAM\b/i,
];

// Top-level statement kinds refused outright.
const FORBIDDEN_TOP = [
  [/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i, "transaction control (the runner owns the transaction)"],
  [/^(SET|RESET)\b/i, "SET/RESET (the runner owns session settings)"],
  [/^(VACUUM|ANALYZE|CLUSTER|REINDEX|CHECKPOINT|LOCK|DISCARD|LISTEN|NOTIFY|UNLISTEN|LOAD|COPY|CALL|DO|SELECT|WITH|VALUES|TABLE|EXPLAIN|EXECUTE|PREPARE|DEALLOCATE|FETCH|MOVE|CLOSE|DECLARE|SECURITY\s+LABEL|IMPORT|REASSIGN|REFRESH)\b/i, "statement kind not allowed in migrations"],
  [/^\\/, "psql meta-command"],
  [/^CREATE\s+(EXTENSION|ROLE|USER|GROUP|DATABASE|TABLESPACE|SERVER|FOREIGN|PUBLICATION|SUBSCRIPTION|EVENT\s+TRIGGER|RULE|POLICY|CAST|CONVERSION|COLLATION|OPERATOR|AGGREGATE|ACCESS\s+METHOD|LANGUAGE|TRANSFORM|STATISTICS|TEXT\s+SEARCH|DOMAIN|USER\s+MAPPING)\b/i, "CREATE of this object kind is not allowed"],
  [/^ALTER\s+(SYSTEM|ROLE|USER|GROUP|DATABASE|TABLESPACE|DEFAULT\s+PRIVILEGES|EXTENSION|SERVER|EVENT\s+TRIGGER|PUBLICATION|SUBSCRIPTION|LARGE\s+OBJECT)\b/i, "ALTER of this object kind is not allowed"],
  [/^DROP\s+(OWNED|ROLE|USER|GROUP|DATABASE|TABLESPACE|EXTENSION|SERVER|EVENT\s+TRIGGER|PUBLICATION|SUBSCRIPTION|POLICY|RULE|CAST|LANGUAGE)\b/i, "DROP of this object kind is not allowed"],
];

// ---------------------------------------------------- statement parsers
// Each returns { kind, verb, target, creates?, drops?, refs? } or null.

const RX = {
  createSchema: new RegExp(String.raw`^CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})(?:\s+AUTHORIZATION\s+${IDENT})?$`, "i"),
  createTable: new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${QNAME})\b`, "i"),
  createView: new RegExp(String.raw`^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(${QNAME})\b`, "i"),
  createIndex: new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})?\s*ON\s+(?:ONLY\s+)?(${QNAME})\b`, "i"),
  createSeq: new RegExp(String.raw`^CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})\b`, "i"),
  createFunc: new RegExp(String.raw`^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(${QNAME})\s*\(([^)]*)\)`, "i"),
  createType: new RegExp(String.raw`^CREATE\s+TYPE\s+(${QNAME})\b`, "i"),
  createTrigger: new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${IDENT})\b.*?\bON\s+(${QNAME})\b.*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(${QNAME})\s*\(`, "i"),
  comment: new RegExp(String.raw`^COMMENT\s+ON\s+(SCHEMA|TABLE|VIEW|COLUMN|INDEX|SEQUENCE|FUNCTION|TYPE|CONSTRAINT\s+${IDENT}\s+ON)\s+(${QNAME})`, "i"),
  alter: new RegExp(String.raw`^ALTER\s+(TABLE|VIEW|SEQUENCE|INDEX|FUNCTION|TYPE|SCHEMA|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\b`, "i"),
  drop: new RegExp(String.raw`^DROP\s+(TABLE|VIEW|SEQUENCE|INDEX|FUNCTION|PROCEDURE|TYPE|SCHEMA|TRIGGER|MATERIALIZED\s+VIEW)\s+(IF\s+EXISTS\s+)?(.+)$`, "i"),
  insert: new RegExp(String.raw`^INSERT\s+INTO\s+(${QNAME})\b`, "i"),
  update: new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?(${QNAME})\b`, "i"),
  delete: new RegExp(String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?(${QNAME})\b`, "i"),
  truncate: new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(.+)$`, "i"),
  grant: new RegExp(String.raw`^(GRANT|REVOKE)\b.*?\bON\s+(?:(?:TABLE|SEQUENCE|FUNCTION|SCHEMA|ALL\s+TABLES\s+IN\s+SCHEMA|ALL\s+SEQUENCES\s+IN\s+SCHEMA|ALL\s+FUNCTIONS\s+IN\s+SCHEMA)\s+)?(${QNAME})`, "i"),
};

function requireQualified(name, what, line) {
  if (!schemaOf(normName(name))) throw new ScanError(`${what} "${name}" must be schema-qualified`, line);
}

function requireAllowed(name, what, line) {
  requireQualified(name, what, line);
  if (!isAllowedTarget(name)) {
    throw new ScanError(`${what} "${name}" is outside the allowed scope (insight.* / api.ge_ct_*)`, line);
  }
}

// Qualified names referenced as FK targets / partition parents / LIKE /
// INHERITS inside a CREATE/ALTER TABLE. These take locks on the referenced
// table, so they must stay inside the allowed scope too.
function checkTableRefs(shape, line) {
  const rx = new RegExp(String.raw`\b(REFERENCES|PARTITION\s+OF|LIKE|INHERITS\s*\()\s*(${QNAME})`, "gi");
  let m;
  while ((m = rx.exec(shape))) {
    requireAllowed(m[2], `${m[1].replace(/\s*\($/, "").toUpperCase()} target`, line);
  }
}

function parseTop(shape, line) {
  let m;
  if ((m = RX.createSchema.exec(shape))) {
    if (normName(m[1]) !== "insight") throw new ScanError(`CREATE SCHEMA ${m[1]}: only schema "insight" may be created`, line);
    return { verb: "CREATE", kind: "schema", creates: { kind: "schema", name: "insight" } };
  }
  if ((m = RX.createTable.exec(shape))) {
    requireAllowed(m[2], "CREATE TABLE", line);
    checkTableRefs(shape, line);
    if (/\bAS\s+(SELECT|WITH|VALUES|TABLE)\b/i.test(shape)) throw new ScanError("CREATE TABLE AS is not allowed", line);
    return { verb: "CREATE", kind: "table", creates: { kind: "relation", name: normName(m[2]) }, ifNotExists: !!m[1] };
  }
  if ((m = RX.createView.exec(shape))) {
    requireAllowed(m[2], "CREATE VIEW", line);
    return { verb: "CREATE", kind: "view", creates: { kind: "relation", name: normName(m[2]) }, orReplace: !!m[1] };
  }
  if ((m = RX.createIndex.exec(shape))) {
    if (m[1]) throw new ScanError("CREATE INDEX CONCURRENTLY cannot run inside the migration transaction", line);
    if (!m[2]) throw new ScanError("CREATE INDEX must name the index (needed for expected-state checks)", line);
    requireAllowed(m[3], "CREATE INDEX ... ON", line);
    const schema = schemaOf(normName(m[3]));
    return { verb: "CREATE", kind: "index", creates: { kind: "relation", name: `${schema}.${normName(m[2])}` } };
  }
  if ((m = RX.createSeq.exec(shape))) {
    requireAllowed(m[1], "CREATE SEQUENCE", line);
    return { verb: "CREATE", kind: "sequence", creates: { kind: "relation", name: normName(m[1]) } };
  }
  if ((m = RX.createFunc.exec(shape))) {
    requireAllowed(m[3], `CREATE ${m[2].toUpperCase()}`, line);
    if (/\bSECURITY\s+DEFINER\b/i.test(shape)) throw new ScanError("SECURITY DEFINER functions are not allowed", line);
    return { verb: "CREATE", kind: "function", creates: { kind: "function", name: normName(m[3]), args: m[4].trim() }, orReplace: !!m[1] };
  }
  if ((m = RX.createType.exec(shape))) {
    requireAllowed(m[1], "CREATE TYPE", line);
    return { verb: "CREATE", kind: "type", creates: { kind: "type", name: normName(m[1]) } };
  }
  if ((m = RX.createTrigger.exec(shape))) {
    requireAllowed(m[2], "CREATE TRIGGER ... ON", line);
    requireAllowed(m[3], "trigger function", line);
    return { verb: "CREATE", kind: "trigger" };
  }
  if (/^CREATE\b/i.test(shape)) throw new ScanError("unrecognised CREATE form", line);

  if ((m = RX.comment.exec(shape))) {
    const kind = m[1].toUpperCase();
    if (kind === "SCHEMA") {
      if (normName(m[2]) !== "insight") throw new ScanError(`COMMENT ON SCHEMA ${m[2]}: only "insight"`, line);
    } else requireAllowed(m[2], `COMMENT ON ${kind}`, line);
    return { verb: "COMMENT", kind: kind.toLowerCase() };
  }
  if (/^COMMENT\b/i.test(shape)) throw new ScanError("unrecognised COMMENT form", line);

  if ((m = RX.alter.exec(shape))) {
    const kind = m[1].toUpperCase();
    if (kind === "SCHEMA") {
      if (normName(m[2]) !== "insight") throw new ScanError(`ALTER SCHEMA ${m[2]}: only "insight"`, line);
      if (/\bRENAME\b/i.test(shape)) throw new ScanError("renaming the insight schema is not allowed", line);
    } else requireAllowed(m[2], `ALTER ${kind}`, line);
    checkTableRefs(shape, line);
    if (/\bSET\s+SCHEMA\b/i.test(shape)) throw new ScanError("ALTER ... SET SCHEMA is not allowed", line);
    if (/\bOWNED\s+BY\b/i.test(shape)) {
      const o = new RegExp(String.raw`\bOWNED\s+BY\s+(${QNAME})`, "i").exec(shape);
      if (o && normName(o[1]) !== "none") requireAllowed(o[1].split(".").slice(0, 2).join("."), "OWNED BY", line);
    }
    return { verb: "ALTER", kind: kind.toLowerCase() };
  }
  if (/^ALTER\b/i.test(shape)) throw new ScanError("unrecognised ALTER form", line);

  if ((m = RX.drop.exec(shape))) {
    const kind = m[1].toUpperCase().replace(/\s+/g, " ");
    if (/\bCASCADE\b/i.test(shape)) throw new ScanError("DROP ... CASCADE is not allowed (could remove dependent objects outside insight)", line);
    let rest = m[3].replace(/\bRESTRICT\s*$/i, "").trim();
    const drops = [];
    if (kind === "TRIGGER") {
      const t = new RegExp(String.raw`^(${IDENT})\s+ON\s+(${QNAME})$`, "i").exec(rest);
      if (!t) throw new ScanError("unrecognised DROP TRIGGER form", line);
      requireAllowed(t[2], "DROP TRIGGER ... ON", line);
      return { verb: "DROP", kind: "trigger" };
    }
    // split comma list, keeping function arg lists together
    const items = [];
    let depth = 0, cur = "";
    for (const ch of rest) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) items.push(cur.trim());
    for (const it of items) {
      const nm = it.replace(/\(.*\)$/s, "").trim();
      if (kind === "SCHEMA") {
        if (normName(nm) !== "insight") throw new ScanError(`DROP SCHEMA ${nm}: only "insight"`, line);
        drops.push({ kind: "schema", name: "insight" });
        continue;
      }
      if (kind === "INDEX") requireQualified(nm, "DROP INDEX", line);
      requireAllowed(nm, `DROP ${kind}`, line);
      const argm = /\((.*)\)$/s.exec(it);
      drops.push(/FUNCTION|PROCEDURE/.test(kind)
        ? { kind: "function", name: normName(nm), args: argm ? argm[1].trim() : null }
        : kind === "TYPE" ? { kind: "type", name: normName(nm) } : { kind: "relation", name: normName(nm) });
    }
    return { verb: "DROP", kind: kind.toLowerCase(), drops, ifExists: !!m[2] };
  }
  if (/^DROP\b/i.test(shape)) throw new ScanError("unrecognised DROP form", line);

  if ((m = RX.insert.exec(shape))) { requireAllowed(m[1], "INSERT INTO", line); return { verb: "INSERT" }; }
  if ((m = RX.update.exec(shape))) { requireAllowed(m[1], "UPDATE", line); return { verb: "UPDATE" }; }
  if ((m = RX.delete.exec(shape))) { requireAllowed(m[1], "DELETE FROM", line); return { verb: "DELETE" }; }
  if ((m = RX.truncate.exec(shape))) {
    if (/\bCASCADE\b/i.test(shape)) throw new ScanError("TRUNCATE ... CASCADE is not allowed", line);
    for (const t of m[1].replace(/\b(RESTART|CONTINUE)\s+IDENTITY\b|\bRESTRICT\b/gi, "").split(",")) {
      requireAllowed(t.trim(), "TRUNCATE", line);
    }
    return { verb: "TRUNCATE" };
  }
  if ((m = RX.grant.exec(shape))) {
    const tgt = m[2];
    if (/IN\s+SCHEMA/i.test(shape) || /\bON\s+SCHEMA\b/i.test(shape)) {
      if (normName(tgt) !== "insight") throw new ScanError(`${m[1]} on schema ${tgt}: only "insight"`, line);
    } else requireAllowed(tgt, m[1].toUpperCase(), line);
    return { verb: m[1].toUpperCase() };
  }
  if (/^(GRANT|REVOKE)\b/i.test(shape)) throw new ScanError("GRANT/REVOKE form not allowed (role membership changes are refused)", line);

  throw new ScanError(`statement not recognised: "${shape.slice(0, 60)}..."`, line);
}

// Write verbs inside function bodies (incl. dynamic SQL literals). Each
// occurrence must be followed by an allowed target.
function scanBody(body, line) {
  const text = body.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
  if (/\b(COMMIT|ROLLBACK)\b/i.test(text)) throw new ScanError("COMMIT/ROLLBACK inside a function body", line);
  // EXECUTE must take format('...') or a string literal so the SQL is visible to this scan
  const ex = /\bEXECUTE\s+(?!format\s*\(\s*'|')/gi;
  if (ex.test(text)) throw new ScanError("dynamic EXECUTE must use format('...') or a literal so it can be scanned", line);
  const verbs = new RegExp(
    String.raw`(\b(?:ON|DO|FOR|OR|BEFORE|AFTER|INSTEAD\s+OF)\s+)?\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+(?:TABLE|VIEW|SEQUENCE|INDEX|FUNCTION|TYPE|SCHEMA|TRIGGER)(?:\s+IF\s+EXISTS)?|ALTER\s+(?:TABLE|VIEW|SEQUENCE|INDEX|FUNCTION|TYPE|SCHEMA)(?:\s+IF\s+EXISTS)?|CREATE\s+(?:UNLOGGED\s+)?(?:TABLE|VIEW|SEQUENCE|INDEX\s+\S+\s+ON|UNIQUE\s+INDEX\s+\S+\s+ON|FUNCTION|TYPE)(?:\s+IF\s+NOT\s+EXISTS)?|GRANT|REVOKE)\s+(?:ONLY\s+)?(${QNAME})?`,
    "gi"
  );
  let m;
  while ((m = verbs.exec(text))) {
    if (m[1]) continue; // ON UPDATE / DO UPDATE / FOR UPDATE / BEFORE INSERT OR UPDATE
    const verb = m[2].toUpperCase().replace(/\s+/g, " ");
    if (/^UPDATE$/.test(verb) && m[3] && /^SET$/i.test(m[3])) continue;
    if (/^(GRANT|REVOKE)$/.test(verb)) throw new ScanError(`${verb} inside a function body is not allowed`, line);
    if (!m[3]) throw new ScanError(`function body: ${verb} without a recognisable target`, line);
    requireAllowed(m[3], `function body: ${verb}`, line);
    if (/^DROP/.test(verb) && /\bCASCADE\b/i.test(text.slice(m.index, m.index + 200))) {
      throw new ScanError("function body: DROP ... CASCADE", line);
    }
  }
}

// Scan a whole file. Returns { statements: [{ sql, line, info }], creates, drops }.
function scanSql(src, { filename = "<sql>" } = {}) {
  const errors = [];
  const statements = [];
  let stmts;
  try {
    stmts = splitStatements(src);
  } catch (e) {
    return { ok: false, errors: [`${filename}: ${e.message}`], statements: [] };
  }
  for (const s of stmts) {
    try {
      for (const rx of FORBIDDEN_ANYWHERE) if (rx.test(s.sql)) throw new ScanError(`forbidden construct ${rx}`, s.line);
      const { shape, bodies, literals } = mask(s.sql);
      for (const [rx, why] of FORBIDDEN_TOP) if (rx.test(shape)) throw new ScanError(why, s.line);
      const info = parseTop(shape, s.line);
      for (const b of bodies) scanBody(b, s.line);
      // format() literals at top level are not executed; nothing to scan there.
      void literals;
      statements.push({ sql: s.sql, line: s.line, info });
    } catch (e) {
      errors.push(`${filename}: ${e.message}`);
    }
  }
  const creates = statements.map((s) => s.info.creates).filter(Boolean);
  const drops = statements.flatMap((s) => s.info.drops || []);
  return { ok: errors.length === 0, errors, statements, creates, drops };
}

module.exports = { scanSql, splitStatements, isAllowedTarget, ScanError };
