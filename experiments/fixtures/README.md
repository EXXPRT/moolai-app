# Synthetic test inputs

Reusable authored cases, generated OCR images and small synthetic vision-response fixtures used by the offline test suites. Expected labels stay outside provider inputs. The vision fixtures contain only questions and responses about synthetic images; they contain no user screenshot or transcript.

These are test dependencies, not experiment reports. Keep generated results, provider traces, personal speech transcripts, screenshots, ledgers and source snapshots in ignored `.data/` storage. Preserve fixture bytes when moving them because corpus and image hashes identify existing baselines.
