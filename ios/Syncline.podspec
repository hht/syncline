# Syncline 的原生模块：Swift 的 Expo 模块（SynclineModule.swift）加 Rust 的设备一侧（rust/native），后者在构建时由 build-rust.sh 编成静态库
Pod::Spec.new do |s|
  s.name = 'Syncline'
  s.version = '0.0.0'
  s.summary = 'Syncline 的设备一侧：本机库、网络与同步在 Rust 的线程上'
  s.homepage = 'https://github.com/hht/syncline'
  s.license = { type: 'UNLICENSED' }
  s.author = 'Syncline'
  s.source = { git: '' }
  s.platforms = { ios: '16.4' }
  s.swift_version = '5.9'
  # ExpoModulesCore 静态链接，依赖它的 pod 也要静态，否则 pod install 拒绝动态框架依赖静态库
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # syncline.h 进框架的伞头文件，同一个框架里的 Swift 直接调它的函数
  s.source_files = '*.{h,swift}'
  s.public_header_files = 'syncline.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  # ring 取随机数（SecRandomCopyBytes）、证书交给系统校验（rustls-platform-verifier）都用 Security.framework
  s.frameworks = 'Security'
  # 每次构建都跑（cargo 自己判断要不要重编），产物在这个 pod 的产物目录；App 链接时找它
  s.script_phase = {
    name: 'Build Rust',
    script: '"$PODS_TARGET_SRCROOT/build-rust.sh"',
    execution_position: :before_compile,
    output_files: ['$(CONFIGURATION_BUILD_DIR)/libsyncline_native.a'],
    always_out_of_date: '1',
  }
  s.user_target_xcconfig = { 'OTHER_LDFLAGS' => '$(inherited) -L"$(PODS_CONFIGURATION_BUILD_DIR)/Syncline" -lsyncline_native' }
end
