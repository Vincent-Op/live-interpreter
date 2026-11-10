import AVFoundation

/// One AVAudioSession + one AVAudioEngine:
///
///   built-in mic -> tap -> resample to 24 kHz PCM16 -> "onAudioChunk" every 200 ms
///
///   headphones player --\
///                        >-- main mixer -> current output route
///   speaker player -----/
///
/// iOS has ONE output route for the whole app, so both players share it. To play on the
/// speaker we override the route to the built-in speaker, play, then remove the override
/// (the route goes back to the AirPods). Headphone audio that arrives while the speaker is
/// active is held and plays afterwards, so the English translation never comes out loud.
/// The mic is muted while the speaker plays (plus a short tail) so we never translate
/// our own output.
///
/// All state lives on the serial queue `q`.
final class AudioEngine {
  var emit: ((String, [String: Any?]) -> Void)?

  private enum SpeakerMode: String {
    case off, switchingOn, on, switchingOff
  }

  static let speakerHoldMs = 500 // keep the speaker route this long after its queue empties
  static let micTailMs = 300 // keep the mic muted this long after the speaker route ends
  static let routeSettleMs = 350 // fallback wait if no route-change notification arrives
  private static let chunkBytes = 9600 // 200 ms of 24 kHz PCM16 mono

  private let q = DispatchQueue(label: "liveinterpreter.audio")
  private let session = AVAudioSession.sharedInstance()
  private let engine = AVAudioEngine()
  private let players: [OutputTarget: AVAudioPlayerNode] = [
    .headphones: AVAudioPlayerNode(),
    .speaker: AVAudioPlayerNode(),
  ]
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private let sendFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

  private var sessionActive = false
  private var graphBuilt = false
  private var capturing = false
  private var tapInstalled = false
  private var converter: AVAudioConverter?
  private var outgoing = Data()

  // `scheduled`: handed to a player, not played back yet. `waiting`: held until the route is right.
  private var scheduled: [OutputTarget: [AVAudioPCMBuffer]] = [.headphones: [], .speaker: []]
  private var waiting: [OutputTarget: [AVAudioPCMBuffer]] = [.headphones: [], .speaker: []]
  private var playing: [OutputTarget: Bool] = [.headphones: false, .speaker: false]
  // Bumped whenever a player is reset, so its stale completion callbacks are ignored.
  private var generation: [OutputTarget: Int] = [.headphones: 0, .speaker: 0]
  private var speakerMode = SpeakerMode.off
  private var switchToken = 0
  private var releaseToken = 0
  private var micGateUntil: CFAbsoluteTime = 0
  private var observers: [NSObjectProtocol] = []

  init() {
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
      self?.q.async { self?.handleRouteChange(AVAudioSession.RouteChangeReason(rawValue: raw)) }
    })
    // Fires when the hardware format changes (e.g. AirPods <-> speaker). The engine has stopped itself.
    observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.q.async { self?.restartEngine(reason: "configuration change") }
    })
  }

  // MARK: - Public API (called from the module, never on `q`)

  func requestPermission(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { done($0) }
    } else {
      session.requestRecordPermission { done($0) }
    }
  }

  func startCapture() throws {
    try q.sync {
      if capturing { return }
      try activateSession()
      capturing = true
      outgoing = Data()
      // The input tap is added while the engine is stopped, so do a full restart.
      try restartEngineOrThrow()
    }
  }

  func stopAll() {
    q.sync {
      capturing = false
      if tapInstalled {
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
      }
      for t in [OutputTarget.headphones, .speaker] { resetPlayer(t) }
      if speakerMode != .off {
        try? session.overrideOutputAudioPort(.none)
        speakerMode = .off
      }
      engine.stop()
      outgoing = Data()
      if sessionActive {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
      }
      emitPlayback()
    }
  }

  func shutdown() {
    stopAll()
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
  }

  func play(base64: String, target: OutputTarget) throws {
    guard let data = Data(base64Encoded: base64), data.count >= 2, let buf = makeBuffer(data) else {
      throw NSError(domain: "LiveAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "playAudio: not valid base64 PCM16"])
    }
    try q.sync {
      if !engine.isRunning { try restartEngineOrThrow() }
      switch target {
      case .headphones:
        if speakerMode == .off {
          schedule(buf, on: .headphones)
          players[.headphones]!.play()
        } else {
          waiting[.headphones, default: []].append(buf)
        }
      case .speaker:
        releaseToken += 1 // cancel a pending switch back to the AirPods
        switch speakerMode {
        case .on:
          schedule(buf, on: .speaker)
          players[.speaker]!.play()
        case .off:
          waiting[.speaker, default: []].append(buf)
          beginSpeaker()
        case .switchingOn, .switchingOff:
          waiting[.speaker, default: []].append(buf) // handled when the route settles
        }
      }
      setPlaying(target, true)
    }
  }

  func stopPlayback(target: OutputTarget?) {
    q.sync {
      let targets = target.map { [$0] } ?? [.headphones, .speaker]
      for t in targets { resetPlayer(t) }
      if targets.contains(.speaker), speakerMode == .on || speakerMode == .switchingOn {
        releaseSpeaker()
      }
      emitPlayback()
    }
  }

  func setVolume(target: OutputTarget, volume: Float) {
    q.sync { players[target]!.volume = max(0, min(volume, 1)) }
  }

  func currentRoute() -> [String: Any] {
    q.sync { routeInfo() }
  }

  // MARK: - Session and engine

  private func activateSession() throws {
    if sessionActive { return }
    // .allowBluetoothA2DP (not .allowBluetooth/HFP): high-quality output to the AirPods.
    // A2DP is output-only, so the input stays on the iPhone's built-in mic, which hears both people.
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
    try session.setActive(true)
    sessionActive = true
    preferBuiltInMic()
  }

  private func preferBuiltInMic() {
    guard let mic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else { return }
    if session.preferredInput?.portType != .builtInMic {
      try? session.setPreferredInput(mic)
    }
  }

  private func buildGraphIfNeeded() {
    if graphBuilt { return }
    for p in players.values {
      engine.attach(p)
      engine.connect(p, to: engine.mainMixerNode, format: playFormat) // the mixer resamples to the hardware rate
    }
    graphBuilt = true
  }

  private func restartEngine(reason: String) {
    guard sessionActive else { return }
    do {
      try restartEngineOrThrow()
    } catch {
      emitError("engine restart (\(reason)) failed: \(error.localizedDescription)")
    }
  }

  /// Stops everything, rebuilds the mic tap for the current hardware format, starts again,
  /// and re-queues audio that hadn't finished playing.
  private func restartEngineOrThrow() throws {
    try activateSession()
    buildGraphIfNeeded()
    engine.stop()
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    for t in [OutputTarget.headphones, .speaker] {
      generation[t, default: 0] += 1
      players[t]!.stop()
    }
    if capturing { installTap() }
    engine.prepare()
    try engine.start()
    for t in [OutputTarget.headphones, .speaker] {
      let pending = scheduled[t] ?? []
      scheduled[t] = []
      pending.forEach { schedule($0, on: t) }
    }
    players[.speaker]!.play()
    if speakerMode == .off { players[.headphones]!.play() } else { players[.headphones]!.pause() }
  }

  // MARK: - Mic capture

  private func installTap() {
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
      emitError("No microphone input available")
      return
    }
    converter = AVAudioConverter(from: inFormat, to: sendFormat)
    // ~100 ms per callback at 48 kHz. Callbacks arrive on an AVFoundation thread, not the render thread.
    input.installTap(onBus: 0, bufferSize: 4800, format: inFormat) { [weak self] buffer, _ in
      self?.handleMic(buffer)
    }
    tapInstalled = true
  }

  private func handleMic(_ buffer: AVAudioPCMBuffer) {
    guard let converter = converter, buffer.frameLength > 0 else { return }
    let db = AudioEngine.levelDb(buffer)
    let ratio = sendFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: sendFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    _ = converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow // keep the resampler's state between callbacks
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
    let bytes = Data(bytes: samples[0], count: Int(out.frameLength) * 2)
    q.async { [weak self] in self?.micData(bytes, db: db) }
  }

  private func micData(_ bytes: Data, db: Float) {
    guard capturing else { return }
    let gated = speakerMode != .off || CFAbsoluteTimeGetCurrent() < micGateUntil
    emit?("onMicLevel", ["db": Double(db), "gated": gated])
    if gated {
      outgoing = Data()
      return
    }
    outgoing.append(bytes)
    while outgoing.count >= AudioEngine.chunkBytes {
      let chunk = Data(outgoing.prefix(AudioEngine.chunkBytes))
      outgoing = Data(outgoing.dropFirst(AudioEngine.chunkBytes))
      emit?("onAudioChunk", ["data": chunk.base64EncodedString(), "durationMs": 200])
    }
  }

  private static func levelDb(_ b: AVAudioPCMBuffer) -> Float {
    guard let ch = b.floatChannelData, b.frameLength > 0 else { return -160 }
    let n = Int(b.frameLength)
    var sum: Float = 0
    for i in 0..<n {
      let s = ch[0][i]
      sum += s * s
    }
    let rms = sqrt(sum / Float(n))
    return rms > 0 ? 20 * log10(rms) : -160
  }

  // MARK: - Playback

  private func makeBuffer(_ data: Data) -> AVAudioPCMBuffer? {
    let frames = data.count / 2
    guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)),
          let channel = buf.floatChannelData?[0] else { return nil }
    buf.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { raw in
      for i in 0..<frames {
        let s = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
        channel[i] = Float(s) / 32768
      }
    }
    return buf
  }

  private func schedule(_ buf: AVAudioPCMBuffer, on t: OutputTarget) {
    scheduled[t, default: []].append(buf)
    let gen = generation[t] ?? 0
    players[t]!.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.q.async { self?.bufferFinished(buf, on: t, generation: gen) }
    }
  }

  private func bufferFinished(_ buf: AVAudioPCMBuffer, on t: OutputTarget, generation gen: Int) {
    guard gen == generation[t] else { return }
    if let i = scheduled[t]?.firstIndex(where: { $0 === buf }) {
      scheduled[t]?.remove(at: i)
    }
    if (scheduled[t] ?? []).isEmpty && (waiting[t] ?? []).isEmpty {
      setPlaying(t, false)
      if t == .speaker { scheduleSpeakerRelease() }
    }
  }

  private func resetPlayer(_ t: OutputTarget) {
    generation[t, default: 0] += 1
    players[t]!.stop()
    scheduled[t] = []
    waiting[t] = []
    playing[t] = false
  }

  // MARK: - Speaker route switching

  private func beginSpeaker() {
    speakerMode = .switchingOn
    players[.headphones]!.pause() // headphone audio waits; it would otherwise come out of the speaker
    do {
      try session.overrideOutputAudioPort(.speaker)
    } catch {
      emitError("Could not switch to speaker: \(error.localizedDescription)")
    }
    awaitRouteSettle()
    emitPlayback()
  }

  private func scheduleSpeakerRelease() {
    releaseToken += 1
    let token = releaseToken
    q.asyncAfter(deadline: .now() + .milliseconds(AudioEngine.speakerHoldMs)) { [weak self] in
      guard let self = self, token == self.releaseToken, self.speakerMode == .on,
            (self.scheduled[.speaker] ?? []).isEmpty, (self.waiting[.speaker] ?? []).isEmpty else { return }
      self.releaseSpeaker()
    }
  }

  private func releaseSpeaker() {
    releaseToken += 1
    speakerMode = .switchingOff
    do {
      try session.overrideOutputAudioPort(.none)
    } catch {
      emitError("Could not switch back from speaker: \(error.localizedDescription)")
    }
    awaitRouteSettle()
    emitPlayback()
  }

  /// The route change is confirmed by a notification; fall back to a timer in case none arrives.
  private func awaitRouteSettle() {
    switchToken += 1
    let token = switchToken
    q.asyncAfter(deadline: .now() + .milliseconds(AudioEngine.routeSettleMs)) { [weak self] in
      self?.routeSettled(token: token)
    }
  }

  private func handleRouteChange(_ reason: AVAudioSession.RouteChangeReason?) {
    if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
      preferBuiltInMic() // AirPods connected/removed: stay on the iPhone mic
    }
    emit?("onRouteChange", ["reason": AudioEngine.name(reason), "route": routeInfo()])
    if speakerMode == .switchingOn || speakerMode == .switchingOff {
      routeSettled(token: switchToken)
    }
  }

  private func routeSettled(token: Int) {
    guard token == switchToken else { return }
    switchToken += 1 // settle only once per switch
    if sessionActive && !engine.isRunning { restartEngine(reason: "route change") }
    switch speakerMode {
    case .switchingOn:
      speakerMode = .on
      let pending = waiting[.speaker] ?? []
      waiting[.speaker] = []
      pending.forEach { schedule($0, on: .speaker) }
      players[.speaker]!.play()
      if pending.isEmpty && (scheduled[.speaker] ?? []).isEmpty { scheduleSpeakerRelease() }
    case .switchingOff:
      speakerMode = .off
      micGateUntil = CFAbsoluteTimeGetCurrent() + Double(AudioEngine.micTailMs) / 1000
      if !(waiting[.speaker] ?? []).isEmpty {
        beginSpeaker() // more speaker audio arrived while switching back
        return
      }
      let pending = waiting[.headphones] ?? []
      waiting[.headphones] = []
      pending.forEach { schedule($0, on: .headphones) }
      players[.headphones]!.play()
    case .off, .on:
      break
    }
    emitPlayback()
  }

  // MARK: - Events

  private func setPlaying(_ t: OutputTarget, _ value: Bool) {
    if playing[t] == value { return }
    playing[t] = value
    emitPlayback()
  }

  private func emitPlayback() {
    emit?("onPlaybackState", [
      "headphones": playing[.headphones] ?? false,
      "speaker": playing[.speaker] ?? false,
      "speakerMode": speakerMode.rawValue,
    ])
  }

  private func emitError(_ message: String) {
    emit?("onError", ["message": message])
  }

  private func routeInfo() -> [String: Any] {
    let route = session.currentRoute
    let port: (AVAudioSessionPortDescription) -> [String: String] = { ["type": $0.portType.rawValue, "name": $0.portName] }
    return [
      "outputs": route.outputs.map(port),
      "inputs": route.inputs.map(port),
      "speakerMode": speakerMode.rawValue,
      "sampleRate": session.sampleRate,
    ]
  }

  private static func name(_ reason: AVAudioSession.RouteChangeReason?) -> String {
    switch reason {
    case .newDeviceAvailable: return "deviceConnected"
    case .oldDeviceUnavailable: return "deviceRemoved"
    case .categoryChange: return "categoryChange"
    case .override: return "override"
    case .wakeFromSleep: return "wakeFromSleep"
    case .noSuitableRouteForCategory: return "noSuitableRoute"
    case .routeConfigurationChange: return "configurationChange"
    default: return "other"
    }
  }
}
