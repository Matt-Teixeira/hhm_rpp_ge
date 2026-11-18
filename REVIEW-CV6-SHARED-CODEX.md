# CV-6 shared module — Codex review

Reviewed 2026-11-18 against the uncommitted reports worktree on `DEV`,
base `e1de116`. No implementation changes made. No actionable CT
regression found in the extraction.

**Checks run**

- `node sme_reports/insights/test/page.test.js`: 5/5 pass.
- `node sme_reports/ct/test/model.test.js`: 14/14 pass.
- `node sme_reports/dev/check_ct.js`: pass, including Chromium,
  six systems, 24 system/period views and escaping.
- The supplied `ctproof/run_proof.sh`: all ten inputs produce identical
  HTML and file names against `git archive HEAD`.
- Five additional comparisons: null `data_through`; `last` evidence
  without `day` while preserving its other fields; no view systems;
  one system without findings; and empty evidence. All identical.
- `node sme_reports/ct/verify.js`: **0 differences / 24,581 comparisons**,
  snapshot `2026-11-18T20:35:49.910Z`, read-only REPEATABLE READ.

The fixture HTML SHA-256 is
`5c3497e68a84daa03e238c1627af3e918cf152d3abebb05838d05abbaa17a10b`.
The proof script prints JavaScript string length: 321,545 characters.
The UTF-8 file is 321,939 bytes. The handoff's byte count is mislabeled;
the identity result and hash are correct.

**Answers to the handoff questions**

1. **Unchanged page:** the moved templates and their call sites retain
   the old interpolation order, whitespace and defaults. The stale
   notice remains in CT; first/last navigation uses the same conditions.
   The extra comparisons cover the named null/evidence/navigation
   cases. The assembled client also retains the old text. This is
   stronger evidence than screenshots alone, although finite variants
   cannot prove every possible malformed model.

2. **Assembler:** section content may end without a newline; I tested
   that successfully. Marker lines themselves require LF and a final
   newline. CRLF files and an unterminated final marker throw, so these
   formatting changes fail the build. A full marker line inside a
   template literal is treated as a delimiter: the format reserves
   those lines and is not a JavaScript parser. Known duplicate markers
   fail rather than quietly selecting a section. Function replacement
   correctly preserves `$&` and `$1`.

   These checks validate the assembly protocol, not the program. Four
   empty sections are accepted; arbitrary broken JavaScript can also
   be inserted. Keep the parse check and each viewer's browser smoke
   check as release checks. Optional hardening: reject empty sections,
   normalize line endings, and explicitly reject leftover markers.
   None is needed to preserve the current CT output.

3. **Checker:** each factory call closes over its own array. CT makes
   one call and continues to clear that same array before sequential
   `run_checks` calls; report generation reads it as before. There is
   no change to canonicalization, comparison counts, diff storage or
   formatting. Concurrent calls in one verifier would still contend
   over module state, as they did before; the existing sequential
   mutation harness does not introduce that condition.

4. **Scope/import checks:** the reports status contains only the three
   CT changes, `insights/`, `cv/`, `dev/check_cv.js`, and the
   `report:cv` package script. `check_ct.js` already requires
   `ct/render.js`, which loads the shared page and assembles the shared
   client, so its failure coverage does not depend on adding a direct
   shared import. Adding the imports would improve the inventory in
   its comment, but is not a missing runtime check.

5. **Remaining CT assumptions:** the seventh-column CSS rule is
   table-specific and CV correctly overrides it. `hookCharts`' optional
   heat/calendar branches are dormant for CV and do not require those
   functions to exist. They are compatible shared tooltip protocols,
   though their ownership could be documented more clearly. The
   stored-evidence sentence works for CV too: it does not claim the
   viewer recomputes the rule. Keep these unchanged for the CT identity
   requirement; any later shared cleanup should have its own CT proof.

Temporary review harness: `/tmp/cv6-extra-ct-proof.js` and
`/tmp/cv6-ct-edges.sh`. No production writes, fixture regeneration,
staging or commits were performed.
