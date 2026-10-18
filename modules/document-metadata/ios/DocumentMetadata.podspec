Pod::Spec.new do |s|
  s.name = 'DocumentMetadata'
  s.version = '0.1.0'
  s.summary = 'Local document metadata and PDF thumbnails'
  s.description = 'Renders local first-page PDF thumbnails without network access.'
  s.author = 'Lightning Piggy'
  s.homepage = 'https://github.com/LightningPiggy/lightning-piggy-mobile'
  s.license = { type: 'MIT' }
  s.platforms = { ios: '15.1' }
  s.source = { git: 'https://github.com/LightningPiggy/lightning-piggy-mobile.git' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PDFKit'
  s.source_files = '*.swift'
end
