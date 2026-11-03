# Scope of models and trace validation

Details for [Models and model checking](model.md): how models abstract sync protocols is documented at the top of each `.tla` file. This page records coverage limits not evident from reading the models and configurations: combinations beyond exhaustive search limits, and what trace validation does not cover.

## Combinations beyond exhaustive search

Combinations of 2 rows with crashes and duplicate message delivery (adding dropped messages further expands the state space); liveness under backend writes combined with crashes and message loss; combinations of point-in-time recovery, backup restore, and 2 rows or deployment disconnects are checked only in separate configurations; tables entering and leaving sync are checked with only 1 device (2 devices with 2 rows exceeds search limits), and when recovery interleaves with table entry, cloud tables have only 1 row; log truncation is combined pairwise with backups, clones, point-in-time recovery, and multi-chunk pulls, while three-way combinations are checked only via simulation random walks; range pulls are checked with only 1 device; log truncation is not combined with tables entering or leaving sync; point-in-time recovery, scope changes, and multi-chunk pulls are not checked together (where a staged position remains valid after recovery but `since` was altered by recovery); local row corruption is not combined with point-in-time recovery; two successive point-in-time recoveries are checked with only 1 device and 1 row (`MCPrivateJumpTwice.big.cfg`).

Safety configurations with 2 devices running full exhaustive searches use symmetry sets (`SYMMETRY Symmetry`: states differing only by swapping two devices are treated as identical). Liveness configurations omit symmetry sets, as symmetry can cause TLC to miss liveness violations.

## What trace validation does not cover

- Trace validation checks only control flow (cookies, pending write counts, staging progress, cloud head version): write payloads are not compared, and data correctness is verified directly by the simulation against model invariants.
- Private space traces enable at most one point-in-time recovery (`MaxRestores`).
- Shared space traces exclude features absent from the model: switching user accounts (clearing rows viewed by the previous user), background row counts per bucket, and rebuilds from scratch: cloud `reset` responses for unrecognized cookies are standalone responses, whereas the model represents rebuilds as a `clear` op at the start of the first chunk of a full pull.
- P8a is checked from the start of the tail (the version chased in the position, including tails chased after a full table scan); final chunks of incremental pulls and notices separately verify that the device cookie is on the current history.
- Undetected anomalies: shared space final chunks older than staged chunks (omitting the device check comparing `seen` is not caught by trace validation). This scenario is guarded by `shared-mirror.test.ts` and the model (`MCSharedChunk`: S1).
