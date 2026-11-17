Pod::Spec.new do |s|
  s.name           = 'SecureClipboard'
  s.version        = '0.1.0'
  s.summary        = 'Sensitive, local-only, expiring clipboard copy for secrets'
  s.description    = 'Copies a secret to UIPasteboard with localOnly and an expirationDate so it never syncs over Universal Clipboard and expires even if the app is killed (#1223).'
  s.author         = 'Lightning Piggy'
  s.homepage       = 'https://github.com/LightningPiggy/lightning-piggy-mobile'
  s.license        = { type: 'MIT' }
  s.platforms      = { ios: '16.4' }
  s.source         = { git: 'https://github.com/LightningPiggy/lightning-piggy-mobile.git' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
end
