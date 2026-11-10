import ExpoModulesCore

enum OutputTarget: String, Enumerable {
  case headphones
  case speaker
}

// Thin bridge to JS. All audio logic lives in AudioEngine.swift.
public final class LiveAudioModule: Module {
  private lazy var audio: AudioEngine = {
    let engine = AudioEngine()
    // sendEvent hands the event to the JS runtime's own queue, so it is safe from any thread.
    engine.emit = { [weak self] name, body in self?.sendEvent(name, body) }
    return engine
  }()

  public func definition() -> ModuleDefinition {
    Name("LiveAudio")

    Events("onAudioChunk", "onMicLevel", "onPlaybackState", "onRouteChange", "onError")

    OnDestroy {
      self.audio.shutdown()
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      self.audio.requestPermission { granted in promise.resolve(granted) }
    }

    // Starts the mic: onAudioChunk fires every 200 ms with base64 PCM16, 24 kHz mono.
    AsyncFunction("start") {
      try self.audio.startCapture()
    }

    // Stops the mic and all playback, and releases the audio session.
    AsyncFunction("stop") {
      self.audio.stopAll()
    }

    // base64 PCM16, 24 kHz mono, little-endian.
    AsyncFunction("playAudio") { (base64: String, target: OutputTarget) in
      try self.audio.play(base64: base64, target: target)
    }

    AsyncFunction("stopPlayback") { (target: OutputTarget?) in
      self.audio.stopPlayback(target: target)
    }

    AsyncFunction("setVolume") { (target: OutputTarget, volume: Double) in
      self.audio.setVolume(target: target, volume: Float(volume))
    }

    Function("getCurrentRoute") { () -> [String: Any] in
      return self.audio.currentRoute()
    }
  }
}
