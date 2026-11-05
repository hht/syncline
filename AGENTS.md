# AGENTS.md — Syncline

> The user's input in the current turn takes precedence over any document.

## What this is

A library that syncs relational SQLite tables between Expo devices (iOS, Android, web) and Cloudflare. It is a standalone product: trade-offs are decided solely by its own requirements and Cloudflare platform limits, never by a specific integrator's current setup; code, comments, and documentation must never mention any integrator's project. For usage, see [README](README.md).

## Core principles

**Highest rule: blast radius before every fix.** Before writing a fix, list every caller, consumer, persisted state, invariant, and documented contract (`docs/`, `model/`) it touches, and state how each one's behavior changes; cover each that could break with a test, and stop for the user when one changes in a way they have not approved.

1. **Deletion first.** Every line must answer "what breaks if this is deleted?" If you cannot answer, trace its origin; if you still cannot answer after tracing, delete it without reducing readability. Inline pass-through or renaming-only functions, types, and files; do not write code for unrequested needs (tests and refactoring excluded).
2. **One module, one question.** Divide modules by question: one question = one design decision that changes independently, never by processing step; keep interfaces much smaller than implementations, state at the top which question the module answers and what it must not know, and prefer deep modules over shallow fragments. Keep dependencies unidirectional and acyclic; separate pure computation from side effects so the core consists of directly testable pure functions.
3. **Sound algorithms.** Identify the essence and choose data structures upfront so scale-determined structures are right by design; measure before tuning local performance.
4. **Trust boundaries.** Parse network, storage, and integrator inputs into exact types at the boundary and use them directly inside. Reserve fallbacks, `try`/`catch`, and defaults for cases that genuinely occur; throw when internal invariants break and catch at the top level to report.
5. **Fix at the root.** Change code where the problem originates; if you cannot find the root cause, stop and report. Write a failing test before fixing a bug.
6. **Primary sources.** Follow the complete design of a mature implementation or paper (PowerSync, ElectricSQL, Replicache, etc.), writing only deviations forced by the platform; verify external system behavior (Cloudflare, SQLite, Expo, Rust crates) against the exact version's source code or probes first, and point to official documentation or version-tagged source code with `@see` in comments.

Hold the protocol to four properties only: never stalls, never loses data, eventually converges, low cost. Do not add complex logic for minor optimizations.

## Directory layout

```
src/            TypeScript: cloud (cloud/, cloudflare/), device JS bindings (expo/), table declarations (tables/), pluggable features (features/), test helpers (test/)
rust/           Device side: core (local database and sync state machine, no networking or timers), native (iOS and Android threads and networking), wasm (web Worker)
ios/ android/   Native Expo module shells; compile rust/native at build time
model/          TLA+ protocol models and configurations
probes/         Probes run against live Cloudflare
docs/           reference/ is integrator documentation; internals/ is architecture decisions and model notes
tools/          Gates (check/) and model runner (dev/)
```

Dependency direction is enforced by gate `depcruise`; rules and rationale live in `.dependency-cruiser.json`.

## Documentation

| When | Read |
|---|---|
| Before starting work or making trade-offs | [Architecture decisions](docs/internals/adr.md) |
| Changing the protocol or `model/` | [Models and model checking](docs/internals/model.md) |
| Changing integrator-visible behavior or numbers | [API](docs/reference/api.md), [Limits](docs/reference/limits.md) |

Code, tests, and models are the source of truth. Documentation records only user-approved decisions and rationale not visible from reading the code; implementation details and trial-and-error history belong in code, tests, and commit messages. Ask the user before changing a user-approved decision (presented as in Reporting), and update the architecture decisions once settled. Write integrator documentation ([README](README.md) and `docs/reference/`) for usage: it may include numbers (numbers in `limits.md` are verified against code by tests), without history.

Code standards not covered by automated gates and enforced by pre-commit review:
- Write identifiers, file names, and branch names in simple English. Write all comments, strings, error messages, test names, and documentation in English.
- Make names clear at the call site first and concise second; name by role, one word per concept ([Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)).
- Use `/** */` on exports: open with one sentence stating what it does, followed by contracts callers must know; inline `//` comments state only why, written as fact.
- Test real behavior with expected values from independent sources; test through public interfaces, preferring real implementations first, fakes second, and mocks only where neither can be wired in.
- Adding a dependency requires explicit user approval.

## Environment

- Always invoke cargo as `~/.cargo/bin/cargo` with `RUSTUP_TOOLCHAIN=` (empty); the toolchain version follows `rust/rust-toolchain.toml`.
- Building web WebAssembly requires LLVM installed via mise (version in `src/build-wasm.mjs`, which prints the install command when missing) and the `wasm-bindgen` CLI matching the `wasm-bindgen` version in `rust/Cargo.toml`; Android additionally requires `cargo-ndk`.
- Under high machine load, a few tests may exceed their timeouts (15 seconds by default): wait for load to drop and re-run rather than changing the tests.

## Commands

The single check entrypoint is `pnpm check` (identical to the local git hook); work is complete only when it is fully green.

- `pnpm check`: runs gates in two parallel batches (Rust-compiling gates finish first), printing only `file:line rule message` with full logs in `.check/<gate>.log`; `--changed` checks only files modified or untracked relative to `HEAD` (used by pre-commit); the full run also measures coverage against the thresholds in `tools/check/coverage.ts`, listing uncovered lines in `.check/test.log`.
- `pnpm q <command>`: prints a concise summary with full logs in `.q/`.
- `pnpm postinstall`: regenerates Workers types from `src/cloudflare/wrangler.jsonc`; runs automatically on install.
- `pnpm model`, `pnpm model:setup`, `pnpm model:big`, `pnpm model:trace`: slow gates for protocol models, excluded from `pnpm check`; run `pnpm model` after changing model logic (comment-only changes skip it) and require it to be fully green before committing; see "How to run" in [Models and model checking](docs/internals/model.md) for when to run each. Estimate duration before long model runs and ask the user first if a run takes tens of minutes or longer.

## Commits

- `commit` and `push` require explicit user instruction in the current turn; never `amend`, `force-push`, or modify git configuration.
- Before committing, perform a line-by-line deletion-first review of the diff and list in your report what was deleted, what was changed, and any debatable lines kept along with their justification.
- Before committing, run an **independent review**: dispatch a fresh read-only subagent (not a fork, without this session's context) to review the diff with the changes, related files, and target properties, looking for regressions, bugs, and discrepancies with documentation and models, citing a reproduction or `file:line` for each finding. Only "must-fix" findings block a commit: data loss or corruption, permanent stalls, security issues, or model discrepancies; after fixing, dispatch another fresh subagent to review the updated diff, for at most two rounds, stopping for user decision if must-fix findings remain after the second round. Fix minor findings in the same turn or note them in the report.
- Each commit makes one self-contained change with its tests in the same commit; keep refactoring separate from features and fixes.
- Follow Conventional Commits, with types restricted to `feat` `fix` `change` `refactor` `test` `docs` `deps` `chore`, no scope or `!`, in English: — gate `commit-message`

  ```
  <type>: <one-line summary of the change>

  - specific change
  ```

## Reporting

- Summarize first, then suggest next steps.
- Every decision left to the user comes with a comparison table of the options (what each changes, its cost and risk, and which of the four properties it affects) and a recommendation with its reason.
- Back every conclusion with evidence (source `file:line`, official documentation link, or measurement); mark unverified inferences as "inferred / unverified". Point out flawed premises directly.
- Use `handoff` when switching sessions, writing the handoff to `HANDOFF.md` at the repository root (overwritten each time, never committed); read it first in the new session.

## Agent skills

| Intent | Skill | Output location |
|---|---|---|
| Refine designs and resolve open questions | `grill-with-docs` | Architecture decisions |
| Research library or protocol facts | `research` | Research in system temp dir; user trade-offs in architecture decisions |
| Implement from entrypoints | `tdd` (interface vocabulary in `codebase-design`) | Code and tests |
| Diagnose hard bugs | `diagnosing-bugs` | Root cause in commit message |
| Edit `AGENTS.md` or skills | `writing-for-agents` | — |
| Hand off between sessions | `handoff` | `HANDOFF.md` at repo root |
