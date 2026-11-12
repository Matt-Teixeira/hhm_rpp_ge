# Code review: CV C1

## Round 1 finding (fixed)

- **[P2] Make the findings prefix filter independent of `standard_conforming_strings`** — fixed in round 2 at `insight/findings/verify.js:20`.

  The first draft used `finding_key NOT LIKE 'cv\\_%'`; with PostgreSQL's `standard_conforming_strings=off`, the pattern could broaden to `cv_%` and hide non-CV keys such as `cva`. The replacement `left(finding_key, 3) <> 'cv_'` is independent of that setting. PostgreSQL defaults the setting to `on`, but `off` remains valid. See PostgreSQL's [string literal compatibility setting](https://www.postgresql.org/docs/current/runtime-config-compatible.html).

## Round 2 re-review

**No new findings.** The replacement predicate drops exactly keys beginning `cv_`, while retaining `cva`, `cvx_unknown`, `cv`, and ordinary CT keys. The same equivalent prefix form is used in the CV catalog counts, extra-key query, and foreign-finding check; I found no remaining `LIKE` prefix filter with a backslash in those paths. `left()` is a suitable compatibility choice here and avoids depending on PostgreSQL 11's `starts_with()` availability.

## Review notes

- The two metric catalog filters use `cv.%`; the dot is literal in a `LIKE` pattern, so those filters select the intended namespace.
- The catalog counts and registry comparisons remain unchanged for CT-only catalogs. The derived-key count is still scoped by the explicit `DERIVED_KEYS` array.
- `CV_AWARE` is exported by all three verifier modules used by the preflight interlock. The helper test exercises the missing-module case; I found no issue with the gate wiring.
- The read-only catalog counts and findings totals identified in the handoff are not used as acceptance gates elsewhere in CT code. The findings catalog sync's extra-key log can include CV keys, as described in the handoff, but it does not mutate or reject them.
- I reviewed the diff and relevant call sites. I did not rerun tests or the local PostgreSQL harness; the round 2 test and database results above are from the handoff.
