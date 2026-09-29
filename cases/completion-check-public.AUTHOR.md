# Public completion-check cases

Authored by an independent Codex worker, 2026-09-29.

For action parts, I labeled a part true only when the receipts show that the action was carried out. The claimed result never counts as action evidence. For reply parts, I labeled a part true only when the claimed result contains the requested content as an outcome, not a plan or promise. For file parts, I labeled a part true only when `receipts.files_written` contains the exact requested path with more than zero bytes. A case is `done` when all parts are true, `not_done` when all parts are false, and `partial` otherwise. A claimed result is an echo only when it restates the task or instructions without providing an outcome of its own.

The set contains 36 cases: 12 done, 12 partial, and 12 not_done. Echo labels are true for 8 cases and false for 28 cases.

The author never saw the judge's prompts or any result, and did not run the judge.
