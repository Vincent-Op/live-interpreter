import AVFoundation
import MediaPlayer
import UIKit

/// One AVAudioSession + one AVAudioEngine:
///
///   built-in mic -> tap -> resample to 24 kHz PCM16 -> "onAudioChunk" every 200 ms (while streaming)
///
///   headphones player --\
///                        >-- main mixer -> current output route
///   speaker player -----/
///
/// iOS has ONE output route for the whole app, so both players share it. To play on the
/// speaker we override the route to the built-in speaker, play, then remove the override
/// (the route goes back to the AirPods). Headphone audio that arrives while the speaker is
/// active is held and plays afterwards, so the English translation never comes out loud.
/// The mic is muted while speaker audio is actually playing (plus a short tail) so we never
/// translate our own output.
///
/// All state lives on the serial queue `q`.
final class AudioEngine {
  var emit: ((String, [String: Any?]) -> Void)?

  private enum SpeakerMode: String {
    case off, switchingOn, on, switchingOff
  }

  // Tunable from JS via configure().
  private var speakerHoldMs = 600 // keep the speaker route this long after its audio ends (when not held)
  private var micTailMs = 300 // keep the mic muted this long after speaker audio ends
  static let routeSettleMs = 350 // fallback wait if no route-change notification arrives
  private static let chunkBytes = 9600 // 200 ms of 24 kHz PCM16 mono
  private static let prerollChunks = 2 // replayed when streaming starts, so the first word isn't lost

  private let q = DispatchQueue(label: "liveinterpreter.audio")
  private let session = AVAudioSession.sharedInstance()
  private var engine = AVAudioEngine()
  private var players: [OutputTarget: AVAudioPlayerNode] = [.headphones: AVAudioPlayerNode(), .speaker: AVAudioPlayerNode()]
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private let sendFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

  private var sessionActive = false
  private var graphBuilt = false
  private var capturing = false
  private var streaming = true // the test screen expects chunks; the interpreter turns this off
  private var tapInstalled = false
  private var converter: AVAudioConverter?
  private var outgoing = Data()
  private var preroll: [Data] = []
  private var lastLevelAt: CFAbsoluteTime = 0

  // `scheduled`: handed to a player, not played back yet. `waiting`: held until the route is right.
  private var scheduled: [OutputTarget: [AVAudioPCMBuffer]] = [.headphones: [], .speaker: []]
  private var waiting: [OutputTarget: [AVAudioPCMBuffer]] = [.headphones: [], .speaker: []]
  private var playing: [OutputTarget: Bool] = [.headphones: false, .speaker: false]
  // Bumped whenever a player is reset, so its stale completion callbacks are ignored.
  private var generation: [OutputTarget: Int] = [.headphones: 0, .speaker: 0]
  private var speakerMode = SpeakerMode.off
  private var speakerHeld = false // JS asked to keep the speaker route (a whole ME turn)
  private var switchToken = 0
  private var releaseToken = 0
  private var micGateUntil: CFAbsoluteTime = 0
  private var headphonesConnected = false
  private var observers: [NSObjectProtocol] = []
  private var engineObserver: NSObjectProtocol?
  private var remoteTargets: [(MPRemoteCommand, Any)] = []
  private var lastRemoteAt: CFAbsoluteTime = 0
  private var lastRouteChangeAt: CFAbsoluteTime = 0
  private var lastTapAt: CFAbsoluteTime = 0

  init() {
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
      let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
      self?.q.async { self?.handleRouteChange(AVAudioSession.RouteChangeReason(rawValue: raw), previous: previous) }
    })
    observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
      let opts = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      self?.q.async { self?.handleInterruption(AVAudioSession.InterruptionType(rawValue: raw), options: opts) }
    })
    observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
      self?.q.async { self?.handleMediaServicesReset() }
    })
    observeEngine()
    headphonesConnected = AudioEngine.hasHeadphones(session.currentRoute)
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
      preroll = []
      // The input tap is added while the engine is stopped, so do a full restart.
      try restartEngineOrThrow()
    }
  }

  func stopAll() {
    q.sync {
      capturing = false
      streaming = true
      if tapInstalled {
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
      }
      for t in [OutputTarget.headphones, .speaker] { resetPlayer(t) }
      speakerHeld = false
      if speakerMode != .off {
        try? session.overrideOutputAudioPort(.none)
        speakerMode = .off
      }
      engine.stop()
      outgoing = Data()
      preroll = []
      if sessionActive {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
      }
      emitPlayback()
    }
  }

  func shutdown() {
    stopAll()
    setRemoteCommands(false)
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
    if let o = engineObserver { NotificationCenter.default.removeObserver(o) }
  }

  /// While off, mic audio stays native (no JS events = less battery). Turning it on first
  /// replays the last ~400 ms, in case they started speaking just before the tap.
  func setStreaming(_ on: Bool) {
    q.sync {
      if on && !streaming {
        let gated = isMicGated()
        if !gated { preroll.forEach { emitChunk($0) } }
        preroll = []
      }
      streaming = on
    }
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

  /// on: switch to the speaker now and keep it until released. off: release once speaker audio ends.
  func holdSpeaker(_ on: Bool) throws {
    try q.sync {
      speakerHeld = on
      if on {
        if !engine.isRunning { try restartEngineOrThrow() }
        releaseToken += 1
        if speakerMode == .off { beginSpeaker() }
      } else if speakerMode == .on, (scheduled[.speaker] ?? []).isEmpty, (waiting[.speaker] ?? []).isEmpty {
        releaseSpeaker()
      }
      // Otherwise: released by bufferFinished -> scheduleSpeakerRelease, or by routeSettled.
    }
  }

  func stopPlayback(target: OutputTarget?) {
    q.sync {
      let targets = target.map { [$0] } ?? [.headphones, .speaker]
      for t in targets { resetPlayer(t) }
      if targets.contains(.speaker) {
        speakerHeld = false
        if speakerMode == .on || speakerMode == .switchingOn { releaseSpeaker() }
      }
      emitPlayback()
    }
  }

  func configure(speakerHoldMs: Int?, micTailMs: Int?) {
    q.sync {
      if let v = speakerHoldMs { self.speakerHoldMs = max(0, v) }
      if let v = micTailMs { self.micTailMs = max(0, v) }
    }
  }

  func setVolume(target: OutputTarget, volume: Float) {
    q.sync { players[target]!.volume = max(0, min(volume, 1)) }
  }

  func currentRoute() -> [String: Any] {
    q.sync { routeInfo() }
  }

  /// AirPods stem press / lock-screen play-pause -> "onRemoteCommand". Experimental: iOS only
  /// sends these to the app it considers "now playing".
  func setRemoteCommands(_ on: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let center = MPRemoteCommandCenter.shared()
      for (command, target) in self.remoteTargets { command.removeTarget(target) }
      self.remoteTargets.removeAll()
      guard on else {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        UIApplication.shared.endReceivingRemoteControlEvents()
        return
      }
      UIApplication.shared.beginReceivingRemoteControlEvents()
      // Single press arrives as play, pause or toggle (depending on what iOS thinks the state is);
      // a double press arrives as next track.
      let commands: [(MPRemoteCommand, String)] = [
        (center.togglePlayPauseCommand, "single"),
        (center.playCommand, "single"),
        (center.pauseCommand, "single"),
        (center.nextTrackCommand, "double"),
      ]
      for (command, name) in commands {
        command.isEnabled = true
        let target = command.addTarget { [weak self] _ in
          self?.q.async { self?.remoteCommand(name) }
          return .success
        }
        self.remoteTargets.append((command, target))
      }
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: "LiveInterpreter",
        MPMediaItemPropertyArtist: "Press to translate THEM",
        MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        MPNowPlayingInfoPropertyIsLiveStream: true,
      ]
      MPNowPlayingInfoCenter.default().playbackState = .playing
    }
  }

  // MARK: - Session and engine

  private func activateSession() throws {
    if sessionActive { return }
    // .allowBluetoothA2DP (not .allowBluetooth/HFP): high-quality output to the AirPods.
    // A2DP is output-only, so the input stays on the iPhone's built-in mic, which hears both people.
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
    try? session.setPreferredIOBufferDuration(0.02) // fewer wake-ups than the default; still low latency
    try? session.setPrefersNoInterruptionsFromSystemAlerts(true) // incoming calls show as a banner instead
    try? session.setAllowHapticsAndSystemSoundsDuringRecording(true) // iOS mutes haptics while recording otherwise
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

  private func observeEngine() {
    if let o = engineObserver { NotificationCenter.default.removeObserver(o) }
    // Fires when the hardware format changes (e.g. AirPods <-> speaker). The engine has stopped itself.
    engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.q.async { self?.restartEngine(reason: "configuration change") }
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

  // MARK: - Interruptions and resets

  private func handleInterruption(_ type: AVAudioSession.InterruptionType?, options: UInt) {
    guard sessionActive || capturing else { return }
    switch type {
    case .began:
      // The system has already stopped our audio. Drop queued playback so stale audio doesn't
      // play after the call, and forget any speaker override.
      for t in [OutputTarget.headphones, .speaker] { resetPlayer(t) }
      speakerHeld = false
      speakerMode = .off
      sessionActive = false
      emitPlayback()
      emit?("onInterruption", ["state": "began", "resumed": false])
    case .ended:
      // Try to resume even without .shouldResume; it fails harmlessly if iOS doesn't allow it.
      var resumed = false
      do {
        try session.setActive(true)
        sessionActive = true
        try restartEngineOrThrow()
        resumed = true
        armTapWatchdog()
      } catch {
        sessionActive = false // e.g. not allowed while in the background: JS retries via resume()
      }
      emit?("onInterruption", ["state": "ended", "resumed": resumed])
    default:
      break
    }
  }

  /// Re-activate after an interruption that couldn't resume (call from the foreground).
  func resume() throws {
    try q.sync {
      guard capturing || sessionActive else { return }
      try session.setActive(true)
      sessionActive = true
      try restartEngineOrThrow()
      armTapWatchdog()
    }
  }

  /// After a call the tap sometimes stays silent although the engine restarted (reported on
  /// recent iPhones); if no mic audio arrives within a second, rebuild the engine from scratch.
  private func armTapWatchdog() {
    guard capturing else { return }
    let armedAt = CFAbsoluteTimeGetCurrent()
    q.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      guard let self = self, self.capturing, self.lastTapAt < armedAt else { return }
      self.handleMediaServicesReset()
    }
  }

  /// Rare: the system audio daemon restarted. Every audio object is invalid; rebuild them all.
  private func handleMediaServicesReset() {
    engine = AVAudioEngine()
    players = [.headphones: AVAudioPlayerNode(), .speaker: AVAudioPlayerNode()]
    graphBuilt = false
    tapInstalled = false
    sessionActive = false
    speakerMode = .off
    speakerHeld = false
    scheduled = [.headphones: [], .speaker: []]
    waiting = [.headphones: [], .speaker: []]
    playing = [.headphones: false, .speaker: false]
    observeEngine()
    if capturing {
      do {
        try restartEngineOrThrow()
      } catch {
        emitError("Audio system reset and could not restart: \(error.localizedDescription)")
      }
    }
    emitPlayback()
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

  private func isMicGated() -> Bool {
    // Only while speaker audio is actually playing (or queued to), not while the route is merely held.
    return (playing[.speaker] ?? false) || CFAbsoluteTimeGetCurrent() < micGateUntil
  }

  private func micData(_ bytes: Data, db: Float) {
    guard capturing else { return }
    let gated = isMicGated()
    let now = CFAbsoluteTimeGetCurrent()
    lastTapAt = now
    if now - lastLevelAt >= 0.12 { // ~8 level updates per second is plenty for a meter
      lastLevelAt = now
      emit?("onMicLevel", ["db": Double(db), "gated": gated])
    }
    if gated {
      outgoing = Data()
      preroll = []
      return
    }
    outgoing.append(bytes)
    while outgoing.count >= AudioEngine.chunkBytes {
      let chunk = Data(outgoing.prefix(AudioEngine.chunkBytes))
      outgoing = Data(outgoing.dropFirst(AudioEngine.chunkBytes))
      if streaming {
        emitChunk(chunk)
      } else {
        preroll.append(chunk)
        if preroll.count > AudioEngine.prerollChunks { preroll.removeFirst() }
      }
    }
  }

  private func emitChunk(_ chunk: Data) {
    emit?("onAudioChunk", ["data": chunk.base64EncodedString(), "durationMs": 200])
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
      if t == .speaker {
        micGateUntil = CFAbsoluteTimeGetCurrent() + Double(micTailMs) / 1000
        scheduleSpeakerRelease()
      }
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
    if speakerHeld { return }
    releaseToken += 1
    let token = releaseToken
    q.asyncAfter(deadline: .now() + .milliseconds(self.speakerHoldMs)) { [weak self] in
      guard let self = self, token == self.releaseToken, !self.speakerHeld, self.speakerMode == .on,
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

  private func handleRouteChange(_ reason: AVAudioSession.RouteChangeReason?, previous: AVAudioSessionRouteDescription?) {
    if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable { lastRouteChangeAt = CFAbsoluteTimeGetCurrent() }
    if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
      preferBuiltInMic() // AirPods connected/removed: stay on the iPhone mic
    }
    if speakerMode == .off {
      let now = AudioEngine.hasHeadphones(session.currentRoute)
      if reason == .oldDeviceUnavailable, let previous = previous, AudioEngine.hasHeadphones(previous), !now {
        // AirPods removed: drop queued English so it doesn't come out of the phone.
        resetPlayer(.headphones)
        emitPlayback()
      }
      headphonesConnected = now
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
      headphonesConnected = AudioEngine.hasHeadphones(session.currentRoute)
      if !(waiting[.speaker] ?? []).isEmpty || speakerHeld {
        beginSpeaker() // more speaker audio (or a new hold) arrived while switching back
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

  private func remoteCommand(_ name: String) {
    let now = CFAbsoluteTimeGetCurrent()
    if now - lastRemoteAt < 0.5 { return } // one press can arrive as pause+play
    if now - lastRouteChangeAt < 1.0 { return } // taking an AirPod out sends "pause"; ignore it
    lastRemoteAt = now
    emit?("onRemoteCommand", ["command": name])
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
      "headphones": speakerMode == .off ? AudioEngine.hasHeadphones(route) : headphonesConnected,
    ]
  }

  private static func hasHeadphones(_ route: AVAudioSessionRouteDescription) -> Bool {
    let types: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .headphones, .usbAudio]
    return route.outputs.contains { types.contains($0.portType) }
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
