# Models and model checking

Syncline specifies its sync protocols as TLA+ models and checks them exhaustively with TLC. Implementation conformance to the models is guarded by trace validation, random simulation, or tests of specific cases (see [Conformance](#conformance)). This page outlines the models and how to run them; see the detail pages linked below.

## Models

| Model | Scope |
|---|---|
| `model/Private.tla` | Private spaces: offline device writes, pushes, and pulls, combined with crashes, disconnects, deployments, point-in-time recovery, backup restores, storage errors, local row corruption, and explicit user resyncs. Writes are never lost or executed twice, and devices eventually converge to the cloud state. |
| `model/Shared.tla` | Shared spaces: buckets and subscriptions, stale cached copies, space rebuilds, and log truncation. Rows landed on devices always match the visible rows for their subscription at some version, and devices eventually catch up to head. |
| `model/Fanout.tla` | Shared space fanout: chores and broadcast shards deliver to each connection without missing notices or triggering wasted pulls, eventually pushing up to the head version. |
| `model/Schedule.tla` | Durable Object schedule: tasks sharing one alarm through leases, with crashers that reset the object every run and external resets. Scheduling calls are never lost, tasks cut off alongside a crasher still run, a crasher resets the object at most `ResetLimit` times a day, and resets never pause deliveries. |
| `model/Ownership.tla` | Device table ownership across releases and owner switches: tables move between the private space, shared spaces, and local-only use while the signed-in owner or a shared space's owner changes. Owners are optional and need not match across spaces. No table holds rows of a user other than the current owner of where they came from, and a space with a cookie holds exactly its own rows. Local-only writes are lost only to an owner switch, to a space declaring their table, or to the app dropping it, even once the table is retired. The app may drop any table while the database is closed. |

Properties to uphold appear at the end of each model: P1–P3, P5–P7, P9–P11, and P8a, P8k, P8r (private spaces); S1–S2 (shared spaces); `Kept`, `Bounded`, `Exempt`, and `Served` (schedule); `NoLeak`, `Exact`, and `LocalKept` (ownership); `Covers`, `Complete`, `NoWastedPull`, and `CatchesUp` (fanout); along with the ghost invariant `HistConsistent` (commit log consistency with cloud tables). What each configuration checks, its state space size, and how it runs in gates are documented at the top of each `.cfg` file under `model/`.

## How to run

At the repository root: `pnpm model:setup` installs TLC, `pnpm model` runs gate configurations, `pnpm model:big` runs large configurations (excluded from standard gates), and `pnpm model:trace` performs trace validation (set `SIMULATION_SEED` to test different seeds). If inputs (configuration, imported modules, TLC version, and execution flags) are unchanged and the previous run passed, cached results are reused; deleting `.check/model-cache.json` reruns all configurations.

Run `pnpm model` whenever a change in `model/` alters what TLC checks: anything beyond comments, plus the `Gate mode` header of a `.cfg` file, which `tools/dev/model.ts` reads to choose random walk; comment-only changes skip it. All configurations must pass before committing. Run trace validation once a round of protocol changes is complete across both models and implementation; skip it during intermediate commits where implementation is catching up with model changes in stages. Run trace validation during wrap-up when modifying only the implementation or trace logging without touching models.

## Conformance

How each model is held to the implementation, and what that check leaves out:

| Model | Check | Not covered |
|---|---|---|
| `Private.tla` | Trace validation of the private space simulation (`TracePrivate.tla`) | See [Scope](model-scope.md) |
| `Shared.tla` | Trace validation of the shared space simulation (`TraceShared.tla`) | See [Scope](model-scope.md) |
| `Fanout.tla` | Random simulation: drives the real `Fanout` and two `Broadcast` shards with the model's actions (rounds reaching a shard after later writes, lost rounds, timed-out sends, lost acknowledgments, late or failed shard queries, shard resets, restarts), checking every message a connection receives against `Complete` and `NoWastedPull` and, once writes and faults stop, `CatchesUp` (`fanout-simulation.test.ts`); tests of specific cases (`fanout.test.ts`, `broadcast.test.ts`, including a round arriving after the fanout gave up on it) | Messages are checked against the model's properties, not its states (no trace validation yet); the simulation never delivers a round the fanout gave up on, which the model and one test cover; the model lets a shard reuse its last query answer at any time, while the implementation does so for 5 seconds; one incarnation and a fixed shard set (rebuilds and shard set changes have their own tests) |
| `Schedule.tla` | Random simulation: drives the `Schedule` class on SQLite under a fake clock with the model's actions and compares the schedule table entry by entry, the tasks each alarm starts, and, between alarms, the armed alarm, then checks every call is served once calls stop (`schedule-simulation.test.ts`); workerd tests cover real resets (`schedule.workerd.test.ts`) | A simulated reset keeps every write, while a Durable Object reset rolls back uncommitted ones (the lease committed before tasks run is covered by the workerd tests); the object constructors do not run: a restart only replaces the delivery entry at its time if it exists (a real start also inserts a missing one, and moves it to now while shards are behind); time within a class (two entries a lease away at different minutes); failing chores backing off; among suspects with the fewest resets, the model may run any, the simulation the first by name, as the implementation does |
| `Ownership.tla` | Random simulation: drives the device with the model's actions, including misused names, and compares the rows each table holds and every cookie after every step (`ownership-simulation.test.ts`); device tests cover specific cases (`owner.test.ts`, `leaving-sync.test.ts`) | Rows are compared by source only, so a source missing some of its rows goes unnoticed; tables the app drops are recreated at once in the simulation (declaring them recreates them in the device tests) |

## Trace validation

A deterministic simulation runs the real TypeScript and Rust implementation. At each step, it records implementation actions that correspond to model actions (which message was processed and on which base version) along with visible post-step state. `model/TracePrivate.tla` and `model/TraceShared.tla` (one trace per device for shared spaces, with cloud backend writes and deployments recorded across all traces) instruct TLC to search for a model execution whose steps use only the recorded actions and whose final states match the observed states. Failing to find a valid execution indicates that the implementation performed an action forbidden by the model, or that action mapping was recorded incorrectly (following Microsoft CCF's trace validation method).

## Details

- [Scope](model-scope.md): combinations beyond exhaustive search limits, and what trace validation does not cover (protocol abstractions are documented at the top of each `.tla` file).
- [Model assumptions](model-assumptions.md): assumptions taken as axioms in the model and guaranteed by implementation and tests, plus features omitted from the model.
- [Mutation testing](model-mutations.md): intentional model mutations, which configuration catches each mutation with which violated property, and why unflagged mutations are harmless.
