# Growing notes and bounded graph verification

Opt-in candidates reuse Moolai's native controller and injected BrainPort. Neither changes production defaults without a passing review.

Synthetic images can be regenerated with `python3 experiments/brain-verification/fixtures.py` after installing `requirements.txt`; the generator uses the Mac’s Arial font. Expected facts remain in fixture metadata and are never included in provider requests.

`node --import tsx experiments/brain-verification/run.ts offline` scores 24 labelled synthetic questions. The fixed graph policy expands the first search hit, then the first new neighbour, without consulting labels. This evaluates one traversal policy, not the best achievable graph retrieval. Live paired runs let the Agent choose tools under the same six-call limit.

Frozen scoring: supporting notes have relevance 2, bridge notes 1, unrelated notes 0. Recall@5 counts required supporting notes only. nDCG@5 uses gains `2^relevance - 1` and log2 rank discount. Unanswerable queries have no recall/completeness score; they test abstention in Agent answers. Report complete-evidence rate and irrelevant count separately. A connection is never ground truth for an answer.

Agent answers require every expected fact, source support, current revisions, correct citations, and no material false claim. Score proposed and executed tools separately. Traversal adoption requires more fully supported paired answers, no material false claims, and no regression on straightforward queries. Ties keep the current default.

Organization uses six fresh workflows, with expected source coverage, note episodes and essential facts in `fixtures.json`. Check every published summary against the source available at that publication (later corrections cannot be expected earlier). Classify material omitted/invented quantities, attribution, intent or whole numbered issues as medium/high severity. All six candidate workflows must complete with exact source coverage and no material interim or final content error. Boundary-only planning and writing calls are metered independently; the baseline remains available.

Narration checks section coverage, factual qualifications, inequalities, batches of five, and acceptance of the next batch. OCR scores readable-field exact match and unavailable-field false assertions separately from abstention. Validated OCR cannot certify that image extraction was accurate: independently compare raw output with the synthetic image. Four answer handoffs may use only validated evidence.

The paid runner requires a locally frozen source manifest, verified account/prices, a cumulative ledger and explicit authorization. It enforces US$4.50 / 212 calls maximum within US$35.87, retains failed reservations, and never retries automatically. Artifacts, prices, account metadata and raw traces belong in ignored `.data`, not this directory. No microphone, real capture, web research or external task tools are enabled.
