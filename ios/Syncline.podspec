# Syncline native module: Swift Expo module bridging Rust native core compiled into static library by build script.
Pod::Spec.new do |s|
  s.name = 'Syncline'
  s.version = '0.0.0'
  s.summary = 'Syncline on-device sync: local database, networking, and sync on Rust worker threads'
  s.homepage = 'https://github.com/hht/syncline'
  s.license = { type: 'UNLICENSED' }
  s.author = 'Syncline'
  s.source = { git: '' }
  s.platforms = { ios: '16.4' }
  s.swift_version = '5.9'
  # ExpoModulesCore links statically; dependent pods must also be static to avoid dynamic-over-static rejection during pod install.
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Umbrella header exposing C FFI functions directly to Swift within the framework.
  s.source_files = '*.{h,swift}'
  s.public_header_files = 'syncline.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  # Requires Security.framework for ring random bytes (SecRandomCopyBytes) and rustls system certificate verification.
  s.frameworks = 'Security'
  # Runs on every build (cargo determines whether rebuild is needed; installs download each library once); outputs static library to pod configuration build directory.
  s.script_phase = {
    name: 'Build Rust',
    script: '"$PODS_TARGET_SRCROOT/build-rust.sh"',
    execution_position: :before_compile,
    output_files: ['$(CONFIGURATION_BUILD_DIR)/libsyncline_native.a'],
    always_out_of_date: '1',
  }
  s.user_target_xcconfig = { 'OTHER_LDFLAGS' => '$(inherited) -L"$(PODS_CONFIGURATION_BUILD_DIR)/Syncline" -lsyncline_native' }
end
