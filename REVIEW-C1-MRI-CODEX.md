# Review: C1-MRI

## Findings

None. I found the three CT catalog comparisons described in the handoff; I found no additional CT run gate that compares shared catalog contents or findings rows from another source.

## Review notes

- The metric filters `metric_key NOT LIKE 'mri.%'` exclude the `mri.` namespace. In PostgreSQL `LIKE`, `.` is literal and `%` matches the suffix. The metric catalog key constraint requires a dotted key; the CT metric registries also have no `mri.` keys. `left(finding_key, 4) <> 'mri_'` excludes the `mri_` prefix and retains shorter or look-alike keys such as `mri`, `mria`, and `mrix_*`. The added filters have no backslash escape dependency.
- These are the three CT verifier checks that gate catalog correctness: [verify_facts.js](/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/55e9ee15-2148-40b1-8e6c-cee8680b1d44/scratchpad/c1mri/insight/verify_facts.js:14), [derive/verify.js](/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/55e9ee15-2148-40b1-8e6c-cee8680b1d44/scratchpad/c1mri/insight/derive/verify.js:277), and [findings/verify.js](/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/55e9ee15-2148-40b1-8e6c-cee8680b1d44/scratchpad/c1mri/insight/findings/verify.js:22). Other CT references are not catalog gates: `findings/run.js` logs extra catalog keys and reports aggregate counts; `load.js` and the stage's fresh read report counts; none compares those values to an expected count to pass/fail a run. CT findings reads and verification use `source = 'ge_ct'`.
- The CV stage's “CT unchanged” fingerprint intentionally covers non-CV catalog and findings rows, so it includes MRI. It detects mutations during the CV stage rather than rejecting MRI rows for being present; keeping MRI in that fingerprint is appropriate. The MRI-5 wrapper's shared-lock coordination addresses concurrent writes when introduced.
- `cv_scope.test.js`'s fake applies each parsed exclusion as a conjunct, which models the two `AND`ed SQL predicates: keep a row only when neither modality predicate matches. Its LIKE model handles `%`, `_`, and backslash escapes; the new pattern uses no backslash, and the metric key constraint rules out NULL-key semantics. The copied MRI keys and real registry assertions provide complementary checks.
- Keeping the CV test unchanged is appropriate: `cv_scope.test.js` covers the combined filters with CV and MRI keys, and `mri.test.js` checks the MRI interlock and MRI namespace against the CT filters. The CV suite should continue pinning CV behavior without taking ownership of MRI's registry.
- The rollout sequence is sound: close out CV-5, complete/review/commit C1-MRI, run the CT stage rehearsal against prod with the reviewed tree, push/pull the change, and only then begin MRI's first prod write. Keep the 009 migration and C2 grant prerequisites in the plan's stated order; there is no additional schema change in C1-MRI.

## Verification

Ran the four requested no-DB suites from the C1-MRI worktree with `NODE_PATH` pointing to the main checkout's dependencies: `cv_scope.test.js` (7), MRI extract tests (24), MRI findings tests (27), and CV tests (17); all passed. I did not run any CLI, migration runner, or database command.
