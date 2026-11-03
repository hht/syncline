#!/bin/bash
# Builds the Rust native sync engine (`rust/native`) into a static library during Xcode pod build.
# Selects Rust targets based on target platform and architecture, combines slices via lipo into pod build directory,
# and links against the host app (`user_target_xcconfig`).
# Strips Xcode environment variables before invoking cargo to prevent iOS SDKROOT from leaking into host build scripts.
# Invokes rustup cargo wrapper respecting rust/rust-toolchain.toml.
# @see https://doc.rust-lang.org/rustc/platform-support/apple-ios.html
set -euo pipefail
cd "$PODS_TARGET_SRCROOT/../rust"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
libraries=()
for arch in $ARCHS; do
  case "$PLATFORM_NAME:$arch" in
    iphoneos:arm64) target=aarch64-apple-ios ;;
    iphonesimulator:arm64) target=aarch64-apple-ios-sim ;;
    iphonesimulator:x86_64) target=x86_64-apple-ios ;;
    *) echo "error: Syncline does not support building for $PLATFORM_NAME $arch" >&2; exit 1 ;;
  esac
  env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin CARGO_HOME="$cargo_home" DEVELOPER_DIR="$DEVELOPER_DIR" \
    IPHONEOS_DEPLOYMENT_TARGET="$IPHONEOS_DEPLOYMENT_TARGET" \
    "$cargo_home/bin/cargo" build --locked --release -p syncline-native --target "$target"
  libraries+=("target/$target/release/libsyncline_native.a")
done
lipo -create "${libraries[@]}" -output "$CONFIGURATION_BUILD_DIR/libsyncline_native.a"
