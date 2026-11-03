#!/bin/bash
# Xcode 构建 Syncline 这个 pod 时把 Rust 的设备一侧（rust/native）编成静态库：按这次构建的平台与架构选 Rust 的目标，几个架构合成一个，
# 放进这个 pod 的产物目录，App 链接它（podspec 的 user_target_xcconfig）。cargo 是增量编译，没改时一两秒。
# 清掉 Xcode 的环境再调 cargo：Xcode 设的 SDKROOT 指向 iOS 的 SDK，编宿主上跑的构建脚本（ring、SQLite 的 build.rs）时会链错平台；
# cc 照 Rust 的目标自己用 xcrun 找 SDK。用 rustup 的 cargo 代理，版本只认 rust/rust-toolchain.toml
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
    *) echo "error: Syncline 没有 $PLATFORM_NAME $arch 的构建" >&2; exit 1 ;;
  esac
  env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin CARGO_HOME="$cargo_home" DEVELOPER_DIR="$DEVELOPER_DIR" \
    IPHONEOS_DEPLOYMENT_TARGET="$IPHONEOS_DEPLOYMENT_TARGET" \
    "$cargo_home/bin/cargo" build --locked --release -p syncline-native --target "$target"
  libraries+=("target/$target/release/libsyncline_native.a")
done
lipo -create "${libraries[@]}" -output "$CONFIGURATION_BUILD_DIR/libsyncline_native.a"
