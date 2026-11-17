# The vendored xcframework + Generated/NostrSDK.swift are fetched by
# scripts/fetch-nostr-sdk-swift.mjs (npm postinstall) — CocoaPods
# prepare_command never runs for development (:path) pods, so pod install
# cannot fetch them itself. Fail loudly with the fix instead of undefined
# rust symbols at link time (or a wall of missing-type compile errors).
%w[nostr_sdkFFI.xcframework Generated/NostrSDK.swift].each do |artifact|
  unless File.exist?(File.join(__dir__, artifact))
    raise "#{artifact} missing — run `npm install` (or `node scripts/fetch-nostr-sdk-swift.mjs`) before pod install"
  end
end

Pod::Spec.new do |s|
  s.name           = 'NostrNative'
  s.version        = '0.44.2'
  s.summary        = 'rust-nostr crypto + relay engine for Lightning Piggy'
  s.description    = 'Native NIP-44 encrypt/decrypt, BIP-340 schnorr sign/verify, and the kind-1059 relay engine (Stage 2 of #1036) over rust-nostr UniFFI Swift bindings — prebuilt nostr_sdkFFI.xcframework, no local Rust toolchain.'
  s.author         = 'Lightning Piggy'
  s.homepage       = 'https://github.com/LightningPiggy/lightning-piggy-mobile'
  s.license        = { type: 'MIT' }
  s.platforms      = { ios: '16.4' }
  s.source         = { git: 'https://github.com/LightningPiggy/lightning-piggy-mobile.git' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  # Module sources + Generated/NostrSDK.swift; the generated file's
  # `#if canImport(nostr_sdkFFI)` resolves against the vendored framework
  # (same topology as bdk-rn's BitcoinDevKit.swift). Explicit, non-recursive
  # globs: the xcframework's per-slice Headers/*.h and any `.nostr-sdk-swift-*`
  # extract dir left by a killed postinstall must never become pod sources.
  s.source_files = ['*.swift', 'Generated/*.swift']
  s.vendored_frameworks = 'nostr_sdkFFI.xcframework'
end
