import ExpoModulesCore

enum OutputTarget: String, Enumerable {
  case headphones
  case speaker
}

struct AudioConfig: Record {
  @Field var speakerHoldMs: Int?
  @Field var micTailMs: Int?
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

    Events("onAudioChunk", "onMicLevel", "onPlaybackState", "onRouteChange", "onInterruption", "onRemoteCommand", "onError")

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

    // Mic chunks only go to JS while streaming; turning it on replays the last ~400 ms first.
    AsyncFunction("setStreaming") { (on: Bool) in
      self.audio.setStreaming(on)
    }

    // Re-activate audio after an interruption that couldn't resume in the background.
    AsyncFunction("resume") {
      try self.audio.resume()
    }

    // Stops the mic and all playback, and releases the audio session.
    AsyncFunction("stop") {
      self.audio.stopAll()
    }

    // base64 PCM16, 24 kHz mono, little-endian.
    AsyncFunction("playAudio") { (base64: String, target: OutputTarget) in
      try self.audio.play(base64: base64, target: target)
    }

    // true: switch to the speaker now and keep it. false: back to the AirPods once speaker audio ends.
    AsyncFunction("holdSpeaker") { (on: Bool) in
      try self.audio.holdSpeaker(on)
    }

    AsyncFunction("setRemoteCommands") { (on: Bool) in
      self.audio.setRemoteCommands(on)
    }

    AsyncFunction("stopPlayback") { (target: OutputTarget?) in
      self.audio.stopPlayback(target: target)
    }

    AsyncFunction("configure") { (options: AudioConfig) in
      self.audio.configure(speakerHoldMs: options.speakerHoldMs, micTailMs: options.micTailMs)
    }

    AsyncFunction("setVolume") { (target: OutputTarget, volume: Double) in
      self.audio.setVolume(target: target, volume: Float(volume))
    }

    Function("getCurrentRoute") { () -> [String: Any] in
      return self.audio.currentRoute()
    }
  }
}
