# Review: CV-1b head-key follow-up

## Findings

No new correctness finding in the reviewed diff.

`store_head_early` writes only when there is a complete file head and the run reads no complete bytes: either `no_new_data`, or `append` with `consumed === 0`. It does not write on `new_file`, `shrunk`, or `no_watermark`, so an insert failure during a full read cannot pair the new head with the old watermark.

The early write does rely on the file at the saved watermark being the file represented by that watermark. If the head key is absent (or `getRedisLine` returns `undefined` on an error) and the file was replaced before this run, an idle same-size file or partial-only append can cause the replacement's head to be stored beside the old file's offset. The parser then cannot detect that replacement on a later run. This is the existing size-only/unknown-head limitation of the first post-deploy append path as well: without an identity key to compare, the parser cannot establish that the current file matches the watermark. It is a residual limitation, not a regression introduced by this follow-up.

Moving Redis reads after `open_syserror` and the nonempty-file check avoids Redis reads and missing-head warnings when no file is available. For a present file, the Redis reads and `plan_read` inputs are unchanged. `remember_head` is called only on the no-data and partial-only early returns, where no watermark update or insert occurs; full-read paths never call it.

## Verification

Static review only; no tests or production operations were run.
