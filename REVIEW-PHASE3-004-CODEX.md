# Code review — Phase 3 checkpoint 1

### F1 — Function overloads are treated as the same object
- Severity: low
- Confidence: confirmed (scanner probe)
- Location: migrations/lib/sqlscan.js:470
- What's wrong: `objKey` uses only `kind` and `name`, even though function create/drop records also carry argument signatures. As a result, dropping `insight.f(integer)` and creating `insight.f(text)` makes the scanner treat the new overload as a recreation of the dropped function. `freshCreates` omits it and `netDrops` omits the drop. The runner's `objectExists` check for functions also checks only whether any overload with that name exists, so it cannot catch the signature mismatch afterward.
- Failure scenario: a down migration drops one overload but leaves another overload of the same name in place. The `netDrops` check can consider the dropped overload recreated and skip checking that it is gone; a leftover function can therefore pass the declared-object check. An up migration can likewise skip its absent-object pre-check for a new overload.
- Evidence: a DB-free probe of `scanSql("DROP FUNCTION insight.f(integer); CREATE FUNCTION insight.f(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")` returned `freshCreates: []` and `netDrops: []`, although the dropped and created signatures differ. Read `objectExists` in `migrations/run.js:125-129`; it queries `pg_proc` by schema and function name only. No database query was run.
- Suggested fix: include a normalized function signature in object identity and check exact signatures in `objectExists` (for example, with `to_regprocedure`). If signature normalization is not reliable enough for the scanner, refuse same-name function drop/re-create pairs and require separate migration handling.

