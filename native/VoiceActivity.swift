import Foundation

/// Operates on echo-cancelled input, not the playback reference. These conservative
/// energy thresholds require acoustic acceptance on each intended device route.
struct VoiceActivity {
    private var voiced: Double = 0
    private var quiet: Double = 0
    private var active = false
    mutating func observe(rms: Double, seconds: Double) -> Bool {
        guard seconds > 0, seconds.isFinite, rms.isFinite else { return false }
        if rms >= 0.012 {
            voiced += seconds; quiet = 0
            if !active && voiced >= 0.12 { active = true; return true }
        } else {
            voiced = 0; quiet += seconds
            if quiet >= 0.35 { active = false }
        }
        return false
    }
}

/// Audio buffers cross a callback boundary in order; no file or microphone recording.
final class SpeechBuffers: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [AVAudioPCMBuffer] = []
    func append(_ buffer: AVAudioPCMBuffer) { lock.lock(); defer { lock.unlock() }; values.append(buffer) }
    func drain() -> [AVAudioPCMBuffer] { lock.lock(); defer { lock.unlock() }; let result = values; values = []; return result }
}
import AVFoundation
