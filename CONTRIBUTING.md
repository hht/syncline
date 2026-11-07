# Contributing

Open pull requests against `dev`. `main` takes only releases.

## Setup

You need Node 26 or later, pnpm (the version in `package.json`), and Rust through rustup (the toolchain in `rust/rust-toolchain.toml`). Building the web WebAssembly also needs LLVM and the `wasm-bindgen` CLI; see Environment in [AGENTS.md](AGENTS.md).

```sh
pnpm install
```

## Before you open a pull request

- `pnpm check` passes. CI and the git hook run it too.
- If you changed `model/` or the protocol, `pnpm model` passes too. See [Models and model checking](docs/internals/model.md).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with the types `feat`, `fix`, `change`, `refactor`, `test`, `docs`, `deps`, and `chore`, without a scope or `!`.

The full rules are in [AGENTS.md](AGENTS.md).

## Security issues

Report them privately; see [SECURITY.md](SECURITY.md).
