"use strict";
// Catalog fingerprint for the migration runner (PLAN-CT-INSIGHTS.md §10,
// rules 2 and 6). One md5 per object: relations (columns, defaults,
// constraints, indexes, triggers, view defs, ACL, owner, partition bounds),
// functions, standalone types and schemas. Statistics (reltuples etc.) are
// deliberately excluded so autovacuum/ANALYZE can't cause false alarms.
//
// Run with the same search_path every time (the runner pins pg_catalog),
// because pg_get_viewdef/regprocedure output depends on it.

const SNAPSHOT_SQL = `
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
    AND nspname !~ '^pg_(toast|temp|toast_temp)'
)
SELECT 'schema:' || quote_ident(ns.nspname) AS key, ns.nspname AS schema, NULL::text AS name,
       md5(concat_ws('|', pg_get_userbyid(n.nspowner), coalesce(n.nspacl, acldefault('n', n.nspowner))::text)) AS h
FROM ns JOIN pg_namespace n ON n.oid = ns.oid
UNION ALL
SELECT 'rel:' || quote_ident(ns.nspname) || '.' || quote_ident(c.relname), ns.nspname, c.relname,
       md5(concat_ws('|',
         c.relkind, pg_get_userbyid(c.relowner), coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))::text, c.reloptions::text, c.relpersistence,
         c.relispartition::text, pg_get_expr(c.relpartbound, c.oid), c.relrowsecurity::text,
         CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
         (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                            || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || coalesce(a.attacl::text, '')
                            || ':' || a.attidentity::text || a.attgenerated::text, ',' ORDER BY a.attnum)
            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
         (SELECT string_agg(co.conname || ':' || pg_get_constraintdef(co.oid), ',' ORDER BY co.conname)
            FROM pg_constraint co WHERE co.conrelid = c.oid),
         (SELECT string_agg(t.tgname || ':' || pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
            FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal),
         (SELECT string_agg(r.rulename || ':' || pg_get_ruledef(r.oid), ',' ORDER BY r.rulename)
            FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN'),
         (SELECT string_agg(p.polname || ':' || coalesce(pg_get_expr(p.polqual, p.polrelid), ''), ',' ORDER BY p.polname)
            FROM pg_policy p WHERE p.polrelid = c.oid),
         CASE WHEN c.relkind IN ('i', 'I') THEN pg_get_indexdef(c.oid) END,
         CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END
       ))
FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'i', 'I', 'c')
UNION ALL
SELECT 'func:' || p.oid::regprocedure::text, ns.nspname, p.proname,
       md5(concat_ws('|', pg_get_userbyid(p.proowner), coalesce(p.proacl, acldefault('f', p.proowner))::text, p.prokind, p.prosecdef::text,
                     p.provolatile, p.prorettype::regtype::text, p.proconfig::text, md5(coalesce(p.prosrc, '')), p.probin))
FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
UNION ALL
SELECT 'type:' || quote_ident(ns.nspname) || '.' || quote_ident(t.typname), ns.nspname, t.typname,
       md5(concat_ws('|', t.typtype, pg_get_userbyid(t.typowner), coalesce(t.typacl, acldefault('T', t.typowner))::text,
                     (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid),
                     format_type(t.typbasetype, t.typtypmod)))
FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
WHERE t.typtype IN ('e', 'd', 'r', 'm')
`;

// Objects a migration is allowed to change.
function inScope(row) {
  if (row.schema === "insight") return true;
  if (row.schema === "api" && row.name && /^ge_ct_/.test(row.name)) return true;
  return false;
}

async function snapshot(conn) {
  const rows = await conn.any(SNAPSHOT_SQL);
  const all = new Map();
  for (const r of rows) all.set(r.key, r);
  return all;
}

function protectedOf(snap) {
  const m = new Map();
  for (const [k, r] of snap) if (!inScope(r)) m.set(k, r.h);
  return m;
}

function scopedOf(snap) {
  const m = new Map();
  for (const [k, r] of snap) if (inScope(r)) m.set(k, r.h);
  return m;
}

function hashes(snap) {
  const m = new Map();
  for (const [k, r] of snap) m.set(k, r.h);
  return m;
}

// diff(a, b) of key -> hash maps
function diff(a, b) {
  const added = [], removed = [], changed = [];
  for (const [k, h] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== h) changed.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}

// Relation locks held by this backend outside pg_catalog and outside the
// allowed scope. Anything stronger than AccessShareLock there means the
// migration could block (or be blocked by) the ingest parsers.
const LOCKS_SQL = `
SELECT n.nspname AS schema, c.relname AS name, l.mode
FROM pg_locks l
JOIN pg_class c ON c.oid = l.relation
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
ORDER BY 1, 2, 3
`;

async function foreignLocks(conn) {
  const rows = await conn.any(LOCKS_SQL);
  return rows.filter((r) => !inScope(r));
}

module.exports = { snapshot, protectedOf, scopedOf, hashes, diff, foreignLocks, inScope };
