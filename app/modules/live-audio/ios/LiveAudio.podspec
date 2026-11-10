Pod::Spec.new do |s|
  s.name           = 'LiveAudio'
  s.version        = '0.1.0'
  s.summary        = 'Mic capture and two-route playback for LiveInterpreter'
  s.description    = 'Captures the built-in mic as 24 kHz PCM16 and plays audio to headphones or the speaker.'
  s.license        = 'MIT'
  s.author         = 'Vincent-Op'
  s.homepage       = 'https://github.com/Vincent-Op/live-interpreter'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
