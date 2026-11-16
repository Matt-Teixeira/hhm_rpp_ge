# Review: MRI-4 findings

## Findings

### P2 — A next-day restart can change a historical crash-loop trip

[`build_context()`](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/findings/context.js:134) stores `full` as “no restart at all” using every restart loaded through the run's `today`, and [`crashes()`](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/findings/context.js:160) uses that count for every death earlier than the day currently being evaluated. For a death at 23:55 on day D and a restart at 00:05 on D+1, replaying findings as of D includes the future restart in `full` and drops the death from D's crash count. That violates the agreed as-of cutoff: a trip evaluated on D may use restart events only through D. The independent SQL has the same issue: `mark_any` includes all matching events through the query's `$1` date, and `cr` uses it for every death before each evaluated day ([`verify_sql.js`](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/findings/verify_sql.js:104)). Thus JS = SQL does not catch this boundary case.

Evaluate restart matches against the day being evaluated, preserving each restart's device day so a historical trip cannot see a later event. Add an as-of-purity case with a death just before midnight and a restart just after midnight, and compare the result for D with and without the D+1 event.

## Reviewed paths

- Rules 1–3 and 5–11, their baselines, trip-day evidence, severity escalation, and the 14 evaluated quiet-day fold match the handoff and corresponding SQL. Rule 7 uses the latest spike for observed/baseline when a spike exists, and the seven-day sum for persistent-only trips.
- The residual category logic matches for numeric codes, unknown/unreviewed codes, and the excluded registry; the SQL code list is pinned to the registry. Fixture inputs contain only the listed aggregate/device fields, not message text.
- MRI reads are scoped to MRI facts/daily/codes. Finding reads, deletes, upserts, fingerprints, and stored-row verification are scoped to `source = 'ge_mri'`; foreign `mri_` keys are checked. The shared natural keys are safe while MRI keys remain prefixed. Catalog writes and checks are limited to `mri_` keys.
- CT's fold/reconcile/upsert are reused through `replay_system`, `reconcile`, `totals`, and `UPSERT_SUFFIX`; MRI relabels only `mri_` rows as `ge_mri`. No CV code is loaded.
- Preflight checks the configured limited user and rejects a superuser, schema versions below 9, missing/failed derive state, pending days, owed code labels, fact/daily inventory mismatches, and apply before C1-MRI.
- The catalog choices and rule behavior in plan §9.2/F1–F12 match the reviewed implementation; I found no additional ship-blocking issue in the rules themselves.

## Verification

Ran `node insight/mri/test/findings.test.js`, `node insight/mri/test/mri.test.js`, and `node insight/mri/test/derive.test.js`: all passed (26, 23, and 14 tests respectively). I did not run the MRI CLI or connect to a database.

## Round 2 — P2 closed

I re-checked the finding against plan §9.8 and the added `review MRI4-FINDINGS P2` regression test. The original P2 was incorrect: I misread the `full` count as being used for a death on the evaluated day. `crashes(ctx, D)` uses `strict` for deaths on D, which excludes a restart on D+1; for deaths before D, a restart within ±10 minutes can occur only on the death's day or the next day, so it is within D's cutoff. The SQL's `mark_early` / `mark_any` split follows the same rule.

The added regression test covers the midnight boundary, compares day D with and without the next-day restart across as-of dates, and checks day-by-day replay purity. It passes in the current code. I withdraw the P2; no code change is indicated by this review. The handoff's reported local DB result is consistent with this conclusion.

Verification for this round: `node insight/mri/test/findings.test.js` passed (27 tests). I did not access the external local-DB evidence path or run a database command.
