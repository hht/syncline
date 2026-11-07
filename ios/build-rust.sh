#!/bin/bash
# Builds the Rust native sync engine (`rust/native`) into a static library during Xcode pod build.
# Selects Rust targets based on target platform and architecture, combines slices via lipo into pod build directory,
# and links against the host app (`user_target_xcconfig`).
# A checkout of this repository compiles with cargo; installs carry no Rust sources and download the release's libraries instead.
# Strips Xcode environment variables before invoking cargo to prevent iOS SDKROOT from leaking into host build scripts.
# Invokes rustup cargo wrapper respecting rust/rust-toolchain.toml.
# @see https://doc.rust-lang.org/rustc/platform-support/apple-ios.html
set -euo pipefail
root="$PODS_TARGET_SRCROOT/.."
targets=()
for arch in $ARCHS; do
  case "$PLATFORM_NAME:$arch" in
    iphoneos:arm64) targets+=(aarch64-apple-ios) ;;
    iphonesimulator:arm64) targets+=(aarch64-apple-ios-sim) ;;
    iphonesimulator:x86_64) targets+=(x86_64-apple-ios) ;;
    *) echo "error: Syncline does not support building for $PLATFORM_NAME $arch" >&2; exit 1 ;;
  esac
done
libraries=()
for target in "${targets[@]}"; do libraries+=("$root/rust/target/$target/release/libsyncline_native.a"); done
if [ -f "$root/rust/Cargo.toml" ]; then
  cd "$root/rust"
  cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  for target in "${targets[@]}"; do
    env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin CARGO_HOME="$cargo_home" DEVELOPER_DIR="$DEVELOPER_DIR" \
      IPHONEOS_DEPLOYMENT_TARGET="$IPHONEOS_DEPLOYMENT_TARGET" \
      "$cargo_home/bin/cargo" build --locked --release -p syncline-native --target "$target"
  done
else
  # Finds Node as React Native's Xcode scripts do: Xcode's PATH usually lacks it.
  # @see https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/scripts/xcode/with-environment.sh
  NODE_BINARY=$(command -v node || echo "")
  env_file="${PODFILE_DIR:-$PODS_ROOT/..}/.xcode.env"
  # Sourced as React Native does, without -e and -u, which env files that load nvm trip.
  set +eu
  if [ -f "$env_file" ]; then source "$env_file"; fi
  if [ -f "$env_file.local" ]; then source "$env_file.local"; fi
  set -eu
  if [ -z "$NODE_BINARY" ]; then
    echo "error: Syncline downloads its libraries with Node, which was not found: run echo export NODE_BINARY=\$(command -v node) > .xcode.env in the ios folder" >&2
    exit 1
  fi
  pairs=()
  for i in "${!targets[@]}"; do pairs+=("libsyncline_native-${targets[$i]}.a" "${libraries[$i]}"); done
  "$NODE_BINARY" "$root/src/prebuilt.mjs" "${pairs[@]}"
fi
lipo -create "${libraries[@]}" -output "$CONFIGURATION_BUILD_DIR/libsyncline_native.a"
