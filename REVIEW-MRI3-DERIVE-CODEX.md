# Review: MRI-3 derive

## Findings

### P2 — Derived-query verification discards duplicate rows

[same_rows()](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/verify_derive.js:203) converts each side to a `Set` before comparing. That checks distinct projected values, not row multiplicity. If two source events project to the same fields—for example, two process deaths for the same process in one device second—the SQL and JS result sets can differ by one such row while `diffs` remains zero. The deaths comparison also omits `message_number`, even though the SQL query returns it. This weakens check F's claim that the derived query outputs match.

Compare frequency maps (a multiset) instead of sets, and include the event discriminator in the death comparison where the output is intended to preserve one row per event.

### P2 — New or unreviewed code messages are stored as labels without text review

[build_codes()](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/derive.js:51) builds a label from the most common message template for every `mri.error` code, including codes whose category is NULL because they are new or in the long tail. The masking in [labels.js](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/labels.js:38) removes known identifier patterns, but arbitrary operator text or a site name not tied to a known host can remain. The plan notes operator-entered text in the source, and a future one-off code could make that text its code's modal label.

The leak check in [verify_derive.js](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/verify_derive.js:124) checks hosts, IPv4, MAC, and `SME` identifiers; it does not catch arbitrary free text or every serial/UDI/AE variant. Consider withholding labels for unreviewed codes (or adding an explicit review gate for their templates) and extending the leak check to the identifier forms the masking promises to remove. I did not find a specific current label containing an identifier in the reviewed evidence; this is an exposure path for unreviewed/future source text.

## Reviewed paths

- Daily full and touched-day rebuilds delete then insert within each system transaction. The transaction also clears that system's pending entry and marks codes owed; code rebuild and clearing `codes_pending` share one transaction. Failure paths retain the relevant pending marker for retry. The derive and extract use the same advisory lock.
- `first_at` / `last_at` are device timestamps from `host_local`; `value_last` orders by device time, concurrent record number, then fact id. The daily device-day CHECK in 009 matches these values.
- Code counts and labels are deterministic: mode ties use code-unit order corresponding to SQL `COLLATE "C"`; source retention is handled by the label builder's left join, and missing source text does not remove the fact from code counts.
- The SQL label rewrite and JS masking implement the same transformations for the reviewed ASCII source forms, including host alternatives, newlines, dates, serial patterns, and AE phrases. The source evidence reports agreement across all 823 codes on PostgreSQL 14 and 16; I did not independently run those database checks.
- The derived SQL definitions match the agreed choices in §8.5: restart events include code 200002364 in the inclusive ±10-minute window; sessions and capabilities remain read-only queries; long-tail categories remain NULL; no clock table is introduced; and all known hosts are masked.
- Derive writes only MRI daily/code rows and `ge_mri_derive` job state. It reads shared source rows for labels and does not touch CT/CV tables or code.

## Verification

Source review only. I did not run tests, the MRI CLI, fixture generation, or database commands; the handoff reports the test and local rehearsal results.
