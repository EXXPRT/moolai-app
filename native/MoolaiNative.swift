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
    private var pendingSpeech = 0
    private var speechCancellation = 0
    private var speechWaiters: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]
    private let captured = AudioCaptureBuffer()
    private let asrURL = ProcessInfo.processInfo.environment["MOOLAI_ASR_URL"] ?? "ws://127.0.0.1:8178/v1/audio/transcriptions/realtime"

    override init() {
        super.init()
        speech.delegate = self
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
                    "speaking": speech.isSpeaking, "asrConnected": socket != nil && configured,
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
                if wantsListening, pendingSpeech == 0 { try await startListening() }
                result = ["listening": listening, "flushed": true]
            case "speak":
                guard let text = params["text"] as? String, !text.isEmpty else { throw NativeFailure(message: "speak requires text") }
                try await speak(text)
                result = ["completed": true]
            case "stopSpeaking":
                speechCancellation += 1
                speech.stopSpeaking(at: .immediate)
                result = ["stopped": true]
            case "capture": result = try await capture()
            default: throw NativeFailure(message: "Unknown native method")
            }
            emit(["id": id, "result": result])
        } catch { emit(["id": id, "error": error.localizedDescription]) }
    }

    private func startListening() async throws {
        wantsListening = true
        if let draining = drainTask { try await draining.value }
        // Remember Talk's intent, but never open capture during queued or active speech.
        guard wantsListening, pendingSpeech == 0, !speech.isSpeaking else { return }
        guard hasMicrophone() else {
            wantsListening = false
            throw NativeFailure(message: "No microphone input device is connected. Connect a microphone or headset, select it in System Settings > Sound > Input, then try Talk again.")
        }
        if listening { return }
        guard !starting, !speech.isSpeaking else { throw NativeFailure(message: "Speech is busy; stop spoken output before talking") }
        starting = true
        defer { starting = false }
        if socket != nil { disconnect() }
        generation += 1
        let currentGeneration = generation
        emit(["event": "status", "phase": "microphone_permission"])
        let permission = AVCaptureDevice.authorizationStatus(for: .audio)
        let granted = permission == .authorized ? true : await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            wantsListening = false
            throw NativeFailure(message: "Microphone permission is required. Enable Moolai Native in System Settings > Privacy & Security > Microphone.")
        }
        guard currentGeneration == generation, wantsListening, pendingSpeech == 0 else { return }
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
                    }
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
            // The input node's hardware-facing format is authoritative on macOS.
            // Its unconnected output can still report the engine's default stereo format.
            let format = input.inputFormat(forBus: 0)
            emit(["event": "status", "phase": "configuring_asr", "sampleRate": format.sampleRate])
            guard format.sampleRate > 0, format.channelCount > 0 else { throw NativeFailure(message: "No usable microphone input") }
            try await sendJSON(["type": "session.update", "session": ["sample_rate": Int(format.sampleRate),
                "language": "en-US", "automatic_punctuation": true]])
            emit(["event": "status", "phase": "awaiting_asr_configuration"])
            try await waitUntil(seconds: 8) { self.configured || currentGeneration != self.generation || self.pendingSpeech > 0 }
            guard currentGeneration == generation, wantsListening, pendingSpeech == 0 else {
                // A concurrent TTS/Stop drain owns this socket until its final acknowledgment.
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
                Task { @MainActor in self?.drainCapture() }
            }
            tapInstalled = true
            try audio.start()
            listening = true
            emit(["event": "status", "listening": true, "speaking": false])
        } catch {
            // An interrupted startup must not tear down the drain or a later capture.
            if currentGeneration != generation { return }
            stopCapture()
            disconnect()
            wantsListening = false
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
            catch { self?.fail("Could not send audio to local ASR: \(error.localizedDescription)") }
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
        guard socket != nil else { return }
        // Stop capture before committing, then drain all already queued PCM frames.
        stopCapture()
        drainCapture()
        listening = false
        await sendTail?.value
        defer { disconnect(); emit(["event": "status", "listening": false, "speaking": speech.isSpeaking]) }
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
        listening = false
        wantsListening = false
        emit(["event": "status", "listening": false, "error": message])
    }

    private func disconnect() {
        receiveTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        configured = false
        receiveTask = nil
        sendTail = nil
    }

    private func speak(_ text: String) async throws {
        // Set intent before the first suspension so Flush cannot reopen the microphone.
        pendingSpeech += 1
        let cancellation = speechCancellation
        do {
            if socket != nil { try await stopListening(preserveIntent: true) }
            if cancellation == speechCancellation {
                speech.stopSpeaking(at: .immediate)
                let utterance = AVSpeechUtterance(string: text)
                utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
                emit(["event": "status", "listening": false, "speaking": true])
                await withCheckedContinuation { continuation in
                    speechWaiters[ObjectIdentifier(utterance)] = continuation
                    speech.speak(utterance)
                }
            }
        } catch {
            pendingSpeech -= 1
            throw error
        }
        pendingSpeech -= 1
        emit(["event": "status", "listening": false, "speaking": pendingSpeech > 0 || speech.isSpeaking])
        if wantsListening, pendingSpeech == 0 {
            // A startup interrupted during configuration must unwind before resuming capture.
            if starting { try await waitUntil(seconds: 8) { !self.starting } }
            if wantsListening, pendingSpeech == 0 { try await startListening() }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speechWaiters.removeValue(forKey: ObjectIdentifier(utterance))?.resume() }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speechWaiters.removeValue(forKey: ObjectIdentifier(utterance))?.resume() }
    }

    private func capture() async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw NativeFailure(message: "Screen Recording permission is required for the requested screenshot. Enable Moolai Native in System Settings > Privacy & Security > Screen & System Audio Recording.")
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
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw NativeFailure(message: "Screenshot encoding failed")
        }
        return ["mimeType": "image/png", "dataBase64": png.base64EncodedString()]
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
