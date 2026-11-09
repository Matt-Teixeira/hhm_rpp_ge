# Review: CV-1 schema (migration 007)

## Findings

### P2 — The fact natural key can collide across a DST fold and sequence reset

`migrations/007_cv_schema.sql` makes `(system_id, host_datetime, sequencenumber, metric_key)` unique, but the source provides local date/time without an offset or a fold marker. `host_datetime` is parsed from those fields in the site zone. During the fall-back hour, the same local timestamp occurs twice; if a file rotation resets the sequence between occurrences and the same sequence/time recurs, both source rows resolve to the same key for `cv.error` (and potentially the same named metric). A collision would reject or overwrite a distinct fact, depending on the CV-2 upsert. Adding `errorcode` would distinguish different codes but still collide for repeated records of the same code.

The observed 96,204 rows are unique, including the current sample, but that is evidence about those rows rather than a structural guarantee. The source primary key is already carried as `source_id` plus `source_capture_datetime`; consider using `(system_id, source_id, source_capture_datetime, metric_key)` as the idempotency key. Luxon’s zone documentation describes the fall-back hour as containing local times that occur twice ([Luxon zone documentation](https://github.com/moment/luxon/blob/master/docs/zones.md)).

## Reviewed paths

- The runner’s `api.ge_c[tv]_` allowlist is limited to the intended `api.ge_ct_*` and `api.ge_cv_*` object families. Its in-scope fingerprint set changes by the same prefix. The migration creates only CV objects; I found no CT object alteration or protected object newly in scope in the reviewed change.
- The foreign keys point from the new CV tables to `insight.metric_catalog`; the views only read shared catalog/findings tables. No shared rows or definitions are changed by 007. The referenced catalog’s fingerprint does not include constraints owned by the referencing CV tables. The FK lock can conflict with the CT catalog upsert, but the described short upsert and five-second lock timeout should fail the migration cleanly if contention persists.
- The unpartitioned fact volume is modest: scaling the current ~140k facts per six months from two systems to 18 configured systems is about 1.3M per six months, which remains a reasonable size for this schema and its indexes.
- The daily view’s integer-to-text comparison is type-safe for `errorcode` and `dim`; the metric predicate restricts the code lookup to `cv.error`. The grouped capabilities view and correlated system-summary lookups are reasonable for the stated row counts and indexes.
- The down migration drops the five CV views, three CV tables, grants, and owned sequence; it leaves shared tables and their data in place. I found no residue from the new objects.
- Plan §7.4 C1–C3 cover the shared-table interactions I found: CT verifiers that assume CT-only catalogs, the writer’s missing source-log SELECT grant, and the unfiltered CT findings view for consumers that do not add their own source predicate.

## Verification

- `node --test migrations/test`: passed (exit 0).
- `node migrations/run.js scan`: all 14 migration files passed the static scan.
- No database status, apply, down, or roundtrip commands were run.
