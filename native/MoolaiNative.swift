import AppKit
import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit

struct NativeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Bridges the realtime audio callback into the main actor without losing a final queued buffer.
final class AudioCaptureBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var packets: [Data] = []
    private var byteCount = 0
    private var overflowed = false
    func append(_ bytes: Data) {
        lock.lock(); defer { lock.unlock() }
        guard byteCount + bytes.count <= 2_000_000 else { overflowed = true; return }
        packets.append(bytes); byteCount += bytes.count
    }
    func drain() -> (packets: [Data], overflowed: Bool) {
        lock.lock(); defer { lock.unlock() }
        let result = (packets, overflowed)
        packets.removeAll(); byteCount = 0; overflowed = false
        return result
    }
}

@MainActor
final class NativeCompanion: NSObject, AVSpeechSynthesizerDelegate {
    private let audio = AVAudioEngine()
    private let speech = AVSpeechSynthesizer()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var sendTail: Task<Void, Never>?
    private var pendingBytes = 0
    private var assembler = TranscriptAssembler()
    private var wantsListening = false
    private var listening = false
    private var tapInstalled = false
    private var starting = false
    private var generation = 0
    private var committed = false
    private var drainTask: Task<Void, Error>?
    private var configured = false
    private var socketError: String?
    private let player = AVAudioPlayerNode()
    private let outputEngine = AVAudioEngine()
    private let outputPlayer = AVAudioPlayerNode()
    private var pcmUtterance: String?
    private var pcmOutputOnly = false
    private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var outputOnlyWaiters: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]
    private var playbackWaiter: CheckedContinuation<Void, Never>?
    private var playbackBuffers = 0
    private var playbackFrames: AVAudioFrameCount = 0
    private var playbackEnded = false
    private var speaking = false
    /// A sound paused playback; the host resumes it if the sound was not speech, or stops it.
    private var playbackPaused = false
    private var activity = VoiceActivity()
    private var diagnostics: [[String: Any]] = []
    private var recognitionContext = ""
    private var reconnecting = false
    private var speechCancellation = 0
    private let captured = AudioCaptureBuffer()
    private let asrURL = ProcessInfo.processInfo.environment["MOOLAI_ASR_URL"] ?? "ws://127.0.0.1:8178/v1/audio/transcriptions/realtime"

    override init() {
        super.init()
        speech.delegate = self
        outputEngine.attach(outputPlayer)
        outputEngine.connect(outputPlayer, to: outputEngine.mainMixerNode, format: playbackFormat)
        audio.attach(player)
        audio.connect(player, to: audio.mainMixerNode, format: playbackFormat)
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: audio, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.configurationChanged() }
        }
    }

    func emit(_ value: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(bytes + Data([10]))
    }

    func handle(_ command: [String: Any]) async {
        let id = command["id"] ?? NSNull()
        let params = command["params"] as? [String: Any] ?? [:]
        do {
            let result: [String: Any]
            switch command["method"] as? String {
            case "health":
                result = ["platform": "macOS", "asrURL": asrURL, "listening": listening,
                    "speaking": speaking, "requestedOn": wantsListening, "phase": phase, "diagnostics": diagnostics, "asrConnected": socket != nil && configured,
                    "microphoneAvailable": hasMicrophone(),
                    "microphonePermission": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
                    "screenPermission": CGPreflightScreenCaptureAccess()]
            case "startListening":
                try await startListening()
                result = ["listening": listening]
            case "stopListening":
                try await stopListening()
                result = ["listening": false]
            case "flushListening":
                guard listening || drainTask != nil else { throw NativeFailure(message: "Microphone is not listening") }
                try await stopListening(preserveIntent: true)
                // Pending TTS owns the restart after this shared drain completes.
                if wantsListening { try await startListening() }
                result = ["listening": listening, "flushed": true]
            case "speak":
                guard let text = params["text"] as? String, !text.isEmpty else { throw NativeFailure(message: "speak requires text") }
                try await speak(text)
                result = ["completed": true]
            case "beginSpeechAudio":
                guard let token = params["utteranceId"] as? String else { throw NativeFailure(message: "Missing speech identity") }
                stopPlayback()
                pcmOutputOnly = !wantsListening
                if pcmOutputOnly {
                    outputEngine.prepare(); try outputEngine.start()
                } else if !listening || !audio.isRunning {
                    throw NativeFailure(message: "Capture unavailable; spoken output withheld")
                }
                pcmUtterance = token; speaking = true; publishStatus()
                result = ["ready": true]
            case "speechAudio":
                guard let token = params["utteranceId"] as? String, token == pcmUtterance else {
                    throw NativeFailure(message: "Discarded stale speech audio")
                }
                guard let encoded = params["pcm"] as? String, let bytes = Data(base64Encoded: encoded),
                    bytes.count > 0, bytes.count % 4 == 0, bytes.count <= 96000 else { throw NativeFailure(message: "Invalid speech PCM") }
                let count = AVAudioFrameCount(bytes.count / 4)
                guard playbackFrames + count <= 24000 * 240,
                    let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: count), let samples = buffer.floatChannelData?[0] else {
                    throw NativeFailure(message: "Speech playback queue exceeded")
                }
                _ = bytes.withUnsafeBytes { raw in memcpy(samples, raw.baseAddress!, bytes.count) }
                guard (0..<Int(count)).allSatisfy({ samples[$0].isFinite }) else { throw NativeFailure(message: "Nonfinite speech PCM") }
                buffer.frameLength = count
                let cancellation = speechCancellation
                playbackBuffers += 1; playbackFrames += count
                let target = pcmOutputOnly ? outputPlayer : player
                target.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, cancellation == self.speechCancellation else { return }
                        self.playbackBuffers -= 1; self.playbackFrames -= count; self.finishPlaybackIfReady()
                    }
                }
                if !target.isPlaying && !playbackPaused { target.play() }
                result = ["queued": true]
            case "endSpeechAudio":
                guard params["utteranceId"] as? String == pcmUtterance, pcmUtterance != nil else { throw NativeFailure(message: "Discarded stale speech completion") }
                playbackEnded = true
                if playbackBuffers > 0 { await withCheckedContinuation { playbackWaiter = $0 } }
                finishPlaybackIfReady()
                result = ["completed": true]
            case "stopSpeaking":
                stopPlayback()
                result = ["stopped": true]
            case "resumeSpeaking":
                result = ["resumed": resumePlayback()]
            case "recognitionContext":
                recognitionContext = String((params["text"] as? String ?? "").prefix(400))
                if socket != nil && configured { try await sendJSON(["type": "session.context", "context": recognitionContext]) }
                result = ["updated": true]
            case "capture": result = try await capture(excludeBundleIds: params["excludeBundleIds"] as? [String] ?? [])
            default: throw NativeFailure(message: "Unknown native method")
            }
            emit(["id": id, "result": result])
        } catch {
            if ["startListening", "flushListening", "stopListening"].contains(command["method"] as? String ?? "") {
                if !listening { wantsListening = false }
                socketError = error.localizedDescription; diagnostic("capture_error", ["message": error.localizedDescription]); publishStatus()
            }
            emit(["id": id, "error": error.localizedDescription])
        }
    }

    private func startListening() async throws {
        wantsListening = true
        if !outputOnlyWaiters.isEmpty { stopPlayback() }
        if let draining = drainTask { try await draining.value }
        guard wantsListening else { return }
        guard hasMicrophone() else {
            throw NativeFailure(message: "No microphone input device is connected. Connect a microphone or headset, select it in System Settings > Sound > Input, then try Talk again.")
        }
        if listening { return }
        guard !starting else { return }
        starting = true
        defer { starting = false }
        if socket != nil { disconnect() }
        generation += 1
        let currentGeneration = generation
        emit(["event": "status", "phase": "microphone_permission", "requestedOn": true, "listening": false, "error": NSNull()])
        let permission = AVCaptureDevice.authorizationStatus(for: .audio)
        let granted = permission == .authorized ? true : await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            throw NativeFailure(message: "Microphone permission is required. Enable Moolai Native in System Settings > Privacy & Security > Microphone.")
        }
        guard currentGeneration == generation, wantsListening else { return }
        guard let url = URL(string: asrURL), url.scheme == "ws", ["localhost", "127.0.0.1", "[::1]"].contains(url.host ?? "") else {
            throw NativeFailure(message: "MOOLAI_ASR_URL must be a local ws:// URL")
        }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        configured = false
        committed = false
        socketError = nil
        assembler = TranscriptAssembler()
        task.resume()
        emit(["event": "status", "phase": "connecting_asr"])
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self, !Task.isCancelled, self.socket === task else { return }
                    let bytes: Data
                    switch message { case .data(let d): bytes = d; case .string(let s): bytes = Data(s.utf8); @unknown default: continue }
                    guard let event = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
                    if event["type"] as? String == "session.updated" { self.configured = true }
                    if event["type"] as? String == "input_audio_buffer.committed" { self.committed = true }
                    if event["type"] as? String == "error" {
                        let detail = (event["error"] as? [String: Any])?["message"] as? String ?? "ASR server error"
                        if let raw = (event["error"] as? [String: Any])?["transcript"] as? String, !raw.isEmpty {
                            self.emit(["event": "asr_diagnostic", "text": raw, "message": detail])
                        }
                        self.fail(detail)
                        return
                    }
                    guard self.socketError == nil else { continue }
                    for output in self.assembler.receive(event) { self.emit(output) }
                } catch {
                    if !Task.isCancelled, let self, self.socket === task {
                        self.fail("Local ASR connection failed: \(error.localizedDescription)")
                    }
                    return
                }
            }
        }
        do {
            let input = audio.inputNode
            // Voice processing owns both the microphone path and this engine's playback reference.
            if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
            let format = input.outputFormat(forBus: 0)
            emit(["event": "status", "phase": "configuring_asr", "sampleRate": format.sampleRate])
            guard format.sampleRate > 0, format.channelCount > 0 else { throw NativeFailure(message: "No usable microphone input") }
            try await sendJSON(["type": "session.update", "session": ["sample_rate": Int(format.sampleRate),
                "language": "en-US", "automatic_punctuation": true, "context": recognitionContext]])
            emit(["event": "status", "phase": "awaiting_asr_configuration"])
            try await waitUntil(seconds: 8) { self.configured || currentGeneration != self.generation }
            guard currentGeneration == generation, wantsListening else {
                // A concurrent Stop/Flush drain owns this socket until its final acknowledgment.
                if drainTask == nil, socket === task { disconnect() }
                return
            }
            let captured = self.captured
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                guard let channels = buffer.floatChannelData else { return }
                // In-memory mono PCM16 only. No microphone recording is written to disk.
                var samples = [Int16](repeating: 0, count: Int(buffer.frameLength))
                for frame in 0..<samples.count {
                    var value: Float = 0
                    for channel in 0..<Int(buffer.format.channelCount) { value += channels[channel][frame] }
                    value /= Float(buffer.format.channelCount)
                    samples[frame] = Int16(max(-32768, min(32767, Int((value * 32767).rounded())))).littleEndian
                }
                let data = samples.withUnsafeBytes { Data($0) }
                captured.append(data)
                let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
                let rms = sqrt(samples.reduce(0.0) { $0 + pow(Double(Int16(littleEndian: $1)) / 32768.0, 2) } / Double(max(1, samples.count)))
                Task { @MainActor in
                    guard let self else { return }
                    self.drainCapture()
                    if self.listening && self.activity.observe(rms: rms, seconds: seconds) {
                        // Pause, not stop: a click, cough or echo resumes the sentence once it turns out to hold no words.
                        let wasSpeaking = self.speaking
                        if wasSpeaking { self.pausePlayback() }
                        self.diagnostic("speech_onset", ["interruptedPlayback": wasSpeaking])
                        self.emit(["event": "speech_started", "interruptedPlayback": wasSpeaking, "paused": wasSpeaking])
                    }
                }
            }
            tapInstalled = true
            try audio.start()
            listening = true
            publishStatus()
        } catch {
            // An interrupted startup must not tear down the drain or a later capture.
            if currentGeneration != generation { return }
            stopCapture()
            disconnect()
            throw error
        }
    }

    private func hasMicrophone() -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr
            && device != kAudioObjectUnknown
    }

    private func drainCapture() {
        let batch = captured.drain()
        for bytes in batch.packets { enqueue(bytes) }
        if batch.overflowed { fail("Microphone processing could not keep up; some audio was not transcribed. Please restart listening.") }
    }

    private func stopCapture() {
        stopPlayback()
        audio.stop()
        if tapInstalled { audio.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }

    private func enqueue(_ bytes: Data) {
        guard listening, let activeSocket = socket else { return }
        // Fail visibly on a stalled local server rather than retaining unbounded audio.
        guard pendingBytes + bytes.count <= 2_000_000 else { fail("Local ASR cannot keep up with microphone audio; please restart listening"); return }
        pendingBytes += bytes.count
        let previous = sendTail
        sendTail = Task { [weak self] in
            await previous?.value
            do { try await activeSocket.send(.data(bytes)) }
            catch {
                // A cancelled socket can finish sending after a new capture
                // has started. Its failure must not stop that new session.
                if self?.socket === activeSocket {
                    self?.fail("Could not send audio to local ASR: \(error.localizedDescription)")
                }
            }
            self?.pendingBytes -= bytes.count
        }
    }

    private func stopListening(preserveIntent: Bool = false) async throws {
        if !preserveIntent { wantsListening = false }
        // Flush, Stop and TTS can overlap while awaiting the same final transcript.
        // They must share one commit and the same result, including any failure.
        if let draining = drainTask { try await draining.value; return }
        let draining = Task<Void, Error> {
            defer { self.drainTask = nil }
            try await self.drainListening()
        }
        drainTask = draining
        try await draining.value
    }

    private func drainListening() async throws {
        generation += 1
        guard socket != nil else {
            listening = false
            socketError = nil
            publishStatus()
            return
        }
        // Stop capture before committing, then drain all already queued PCM frames.
        stopCapture()
        drainCapture()
        listening = false
        await sendTail?.value
        defer { disconnect(); publishStatus() }
        emit(["event": "status", "phase": "finishing_transcription", "listening": false])
        try await sendJSON(["type": "input_audio_buffer.commit"])
        // Allow the local Whisper adapter to drain its bounded pending decodes.
        try await waitUntil(seconds: 35) { self.committed }
    }

    private func sendJSON(_ value: [String: Any]) async throws {
        guard let socket else { throw NativeFailure(message: "ASR is disconnected") }
        let data = try JSONSerialization.data(withJSONObject: value)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func waitUntil(seconds: TimeInterval, condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if let socketError { throw NativeFailure(message: socketError) }
            guard Date() < deadline else { throw NativeFailure(message: "Local ASR timed out. Received transcripts remain saved; final transcription was not confirmed.") }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    private func fail(_ message: String) {
        socketError = message
        stopCapture()
        // A failed capture leaves no socket behind, so the next stop succeeds (HRV-01).
        disconnect()
        listening = false
        for output in assembler.cancelPending(reason: message) { emit(output) }
        diagnostic("capture_error", ["message": message])
        emit(["event": "status", "phase": "error", "requestedOn": wantsListening, "listening": false, "speaking": false, "error": message])
    }

    private func disconnect() {
        for output in assembler.cancelPending(reason: "Recognition connection closed before a final result") { emit(output) }
        receiveTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        configured = false
        receiveTask = nil
        sendTail = nil
    }

    private var phase: String {
        if speaking { return "speaking" }
        if !wantsListening { return "off" }
        if socketError != nil { return "error" }
        if reconnecting { return "reconnecting" }
        return listening ? "listening" : wantsListening ? "connecting" : "off"
    }
    private func diagnostic(_ name: String, _ fields: [String: Any] = [:]) {
        diagnostics.append(fields.merging(["name": name, "at": Date().timeIntervalSince1970]) { _, new in new })
        if diagnostics.count > 40 { diagnostics.removeFirst(diagnostics.count - 40) }
    }
    private func publishStatus() {
        emit(["event": "status", "phase": phase, "requestedOn": wantsListening,
            "listening": listening, "speaking": speaking, "error": socketError ?? NSNull()])
    }
    private func configurationChanged() async {
        guard wantsListening, listening, !starting, !reconnecting, !audio.isRunning else { return }
        reconnecting = true; diagnostic("device_reconnecting"); publishStatus()
        do {
            try await stopListening(preserveIntent: true)
            // An explicit Stop during the drain always wins over reconnect intent.
            if wantsListening { try await startListening() }
        } catch { fail("Audio device changed; final transcription or reconnection failed: \(error.localizedDescription). Use Talk to retry.") }
        reconnecting = false; publishStatus()
    }
    private func pausePlayback() {
        guard speaking, !playbackPaused else { return }
        playbackPaused = true
        player.pause(); outputPlayer.pause()
        if speech.isSpeaking { speech.pauseSpeaking(at: .immediate) }
        publishStatus()
    }
    private func resumePlayback() -> Bool {
        guard playbackPaused else { return false }
        playbackPaused = false
        // Playing a node whose engine has stopped (mic turned off meanwhile) raises; that reading is over.
        if pcmUtterance != nil {
            if pcmOutputOnly ? outputEngine.isRunning : audio.isRunning { (pcmOutputOnly ? outputPlayer : player).play() }
            else { stopPlayback(); return false }
        }
        if speech.isPaused { speech.continueSpeaking() }
        publishStatus()
        return true
    }
    private func stopPlayback() {
        playbackPaused = false
        speechCancellation += 1
        player.stop(); outputPlayer.stop(); outputEngine.stop(); pcmUtterance = nil
        speech.stopSpeaking(at: .immediate)
        playbackBuffers = 0; playbackFrames = 0; playbackEnded = false; speaking = false
        let waiter = playbackWaiter; playbackWaiter = nil; waiter?.resume()
        let outputWaiters = outputOnlyWaiters.values; outputOnlyWaiters.removeAll()
        for pending in outputWaiters { pending.resume() }
        publishStatus()
    }
    private func finishPlaybackIfReady() {
        if playbackEnded && playbackBuffers == 0 {
            pcmUtterance = nil; outputEngine.stop()
            speaking = false
            let waiter = playbackWaiter; playbackWaiter = nil; waiter?.resume()
            publishStatus()
        }
    }
    private func speak(_ text: String) async throws {
        if !wantsListening {
            // Explicit output-only requests must never open an input engine or microphone.
            stopPlayback()
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
            speaking = true; publishStatus()
            await withCheckedContinuation { continuation in
                outputOnlyWaiters[ObjectIdentifier(utterance)] = continuation
                speech.speak(utterance)
            }
            return
        }
        guard listening, audio.isRunning else { throw NativeFailure(message: "Capture is unavailable; restart Talk before spoken output.") }
        stopPlayback()
        let cancellation = speechCancellation
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        let buffers = SpeechBuffers()
        speaking = true; publishStatus()
        await withCheckedContinuation { continuation in
            playbackWaiter = continuation
            speech.write(utterance) { [weak self] buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                buffers.append(pcm)
                Task { @MainActor in
                    guard let self else { return }
                    let batch = buffers.drain()
                    guard cancellation == self.speechCancellation else { return }
                    for pcm in batch {
                        if pcm.frameLength == 0 { self.playbackEnded = true; continue }
                        guard let converter = AVAudioConverter(from: pcm.format, to: self.playbackFormat),
                            let output = AVAudioPCMBuffer(pcmFormat: self.playbackFormat,
                                frameCapacity: AVAudioFrameCount(ceil(Double(pcm.frameLength) * 24000 / pcm.format.sampleRate)) + 32) else {
                            self.stopPlayback(); self.diagnostic("playback_conversion_failed"); self.emit(["event": "error", "message": "Speech playback conversion failed. Full text remains on screen."]); return
                        }
                        var consumed = false
                        var error: NSError?
                        converter.convert(to: output, error: &error) { _, status in
                            if consumed { status.pointee = .endOfStream; return nil }
                            consumed = true; status.pointee = .haveData; return pcm
                        }
                        if error != nil { self.stopPlayback(); self.diagnostic("playback_conversion_failed"); self.emit(["event": "error", "message": "Speech playback conversion failed. Full text remains on screen."]); return }
                        guard self.playbackFrames + output.frameLength <= 24000 * 240 else {
                            self.stopPlayback()
                            self.emit(["event": "error", "message": "Speech exceeded its bounded playback queue. Full text remains on screen."])
                            return
                        }
                        self.playbackBuffers += 1; self.playbackFrames += output.frameLength
                        let frames = output.frameLength
                        self.player.scheduleBuffer(output, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                            Task { @MainActor in
                                guard let self, cancellation == self.speechCancellation else { return }
                                self.playbackBuffers -= 1; self.playbackFrames -= frames; self.finishPlaybackIfReady()
                            }
                        }
                        if !self.player.isPlaying { self.player.play() }
                    }
                    self.finishPlaybackIfReady()
                }
            }
        }
    }

    private func outputOnlyFinished(_ utterance: AVSpeechUtterance) {
        if let waiter = outputOnlyWaiters.removeValue(forKey: ObjectIdentifier(utterance)) {
            speaking = false; waiter.resume(); publishStatus()
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.outputOnlyFinished(utterance) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.outputOnlyFinished(utterance) }
    }

    private func capture(excludeBundleIds: [String]) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw NativeFailure(message: "Screen Recording permission is required for the requested screenshot. macOS checks the app that started Moo (the terminal that ran npm run moo, such as Warp), not Moolai Native. Turn it on for that app in System Settings > Privacy & Security > Screen & System Audio Recording, quit and reopen that app, then start Moo again.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw NativeFailure(message: "Main display is unavailable")
        }
        let config = SCStreamConfiguration()
        let scale = min(1, 1920 / Double(display.width))
        config.width = Int(Double(display.width) * scale)
        config.height = Int(Double(display.height) * scale)
        config.showsCursor = false
        // The host's own app is left out by bundle id; the result names only what was actually excluded.
        let excluded = content.applications.filter { excludeBundleIds.contains($0.bundleIdentifier) }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw NativeFailure(message: "Screenshot encoding failed")
        }
        return ["mimeType": "image/png", "dataBase64": png.base64EncodedString(), "excludedApplications": excluded.map { $0.applicationName }]
    }
}

@main
struct MoolaiNativeMain {
    @MainActor static func main() async {
        let companion = NativeCompanion()
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.finishLaunching()
        // Async main keeps the Swift executor available to URLSession and AVFoundation.
        // A blocking NSApplication.run() here can strand URLSession async continuations.
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                while let line = readLine() {
                    guard let data = line.data(using: .utf8),
                          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        Task { @MainActor in companion.emit(["id": NSNull(), "error": "Expected one JSON command per line"]) }
                        continue
                    }
                    Task { @MainActor in await companion.handle(command) }
                }
                finished.resume()
            }
        }
    }
}
