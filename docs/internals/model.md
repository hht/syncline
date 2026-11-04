# Models and model checking

Syncline specifies its sync protocols as TLA+ models and checks them exhaustively with TLC. Implementation conformance to the models is guarded by trace validation. This page outlines the models and how to run them; see the detail pages linked below.

## Models

| Model | Scope |
|---|---|
| `model/Private.tla` | Private spaces: offline device writes, pushes, and pulls, combined with crashes, disconnects, deployments, point-in-time recovery, backup restores, storage errors, local row corruption, and explicit user resyncs. Writes are never lost or executed twice, and devices eventually converge to the cloud state. |
| `model/Shared.tla` | Shared spaces: buckets and subscriptions, stale cached copies, space rebuilds, and log truncation. Rows landed on devices always match the visible rows for their subscription at some version, and devices eventually catch up to head. |
| `model/Fanout.tla` | Shared space fanout: chores and broadcast shards deliver to each connection without missing notices or triggering wasted pulls, eventually pushing up to the head version. |
| `model/Schedule.tla` | Durable Object schedule: tasks sharing one alarm through leases, with crashers that reset the object every run and external resets. Scheduling calls are never lost, tasks cut off alongside a crasher still run, a crasher resets the object at most `ResetLimit` times a day, and resets never pause deliveries. Not trace-validated: workerd tests cover the implementation (`schedule.workerd.test.ts`). |
| `model/Ownership.tla` | Device table ownership across releases and owner switches: tables move between the private space, shared spaces, and local-only use while the signed-in owner or a shared space's owner changes. Owners are optional and need not match across spaces. No table holds rows of a user other than the current owner of where they came from, and a space with a cookie holds exactly its own rows. Local-only writes are lost only to an owner switch or to a space declaring their table, even once the table is retired. Not trace-validated: a random simulation drives the device with the model's actions and checks the rows it holds against the model after every step (`ownership-simulation.test.ts`); device tests cover specific cases (`owner.test.ts`). |

Properties to uphold appear at the end of each model: P1–P3, P5–P7, P9–P11, and P8a, P8k, P8r (private spaces); S1–S2 (shared spaces); `Kept`, `Bounded`, `Exempt`, and `Served` (schedule); `NoLeak`, `Exact`, and `LocalKept` (ownership); `Covers`, `NoWastedPull`, and `CatchesUp` (fanout); along with the ghost invariant `HistConsistent` (commit log consistency with cloud tables). What each configuration checks, its state space size, and how it runs in gates are documented at the top of each `.cfg` file under `model/`.

## How to run

At the repository root: `pnpm model:setup` installs TLC, `pnpm model` runs gate configurations, `pnpm model:big` runs large configurations (excluded from standard gates), and `pnpm model:trace` performs trace validation (set `SIMULATION_SEED` to test different seeds). If inputs (configuration, imported modules, TLC version, and execution flags) are unchanged and the previous run passed, cached results are reused; deleting `.check/model-cache.json` reruns all configurations.

Run `pnpm model` whenever a change in `model/` alters what TLC checks: anything beyond comments, plus the `Gate mode` header of a `.cfg` file, which `tools/dev/model.ts` reads to choose random walk; comment-only changes skip it. All configurations must pass before committing. Run trace validation once a round of protocol changes is complete across both models and implementation; skip it during intermediate commits where implementation is catching up with model changes in stages. Run trace validation during wrap-up when modifying only the implementation or trace logging without touching models.

## Trace validation

A deterministic simulation runs the real TypeScript and Rust implementation. At each step, it records implementation actions that correspond to model actions (which message was processed and on which base version) along with visible post-step state. `model/TracePrivate.tla` and `model/TraceShared.tla` (one trace per device for shared spaces, with cloud backend writes and deployments recorded across all traces) instruct TLC to search for a model execution whose steps use only the recorded actions and whose final states match the observed states. Failing to find a valid execution indicates that the implementation performed an action forbidden by the model, or that action mapping was recorded incorrectly (following Microsoft CCF's trace validation method).

## Details

- [Scope](model-scope.md): combinations beyond exhaustive search limits, and what trace validation does not cover (protocol abstractions are documented at the top of each `.tla` file).
- [Model assumptions](model-assumptions.md): assumptions taken as axioms in the model and guaranteed by implementation and tests, plus features omitted from the model.
- [Mutation testing](model-mutations.md): intentional model mutations, which configuration catches each mutation with which violated property, and why unflagged mutations are harmless.
