import Foundation
@main struct VoiceActivityTests {
    static func main() {
        var detector = VoiceActivity()
        for _ in 0..<100 { assert(!detector.observe(rms: 0.003, seconds: 0.02)) }
        for _ in 0..<5 { assert(!detector.observe(rms: 0.05, seconds: 0.02)) }
        assert(detector.observe(rms: 0.05, seconds: 0.02))
        for _ in 0..<50 { assert(!detector.observe(rms: 0.05, seconds: 0.02)) }
        for _ in 0..<20 { assert(!detector.observe(rms: 0.0, seconds: 0.02)) }
        for _ in 0..<5 { assert(!detector.observe(rms: 0.04, seconds: 0.02)) }
        assert(detector.observe(rms: 0.04, seconds: 0.02))
        assert(!detector.observe(rms: .nan, seconds: 0.02))
        // The tap normally provides 2048-frame buffers. Verify the onset logic
        // with realistic durations, without opening a microphone or playing TTS.
        for sampleRate in [16000.0, 24000.0, 44100.0, 48000.0] {
            var route = VoiceActivity()
            let seconds = 2048.0 / sampleRate
            var elapsed = 0.0
            var onsets = 0
            for _ in 0..<20 {
                elapsed += seconds
                if route.observe(rms: 0.04, seconds: seconds) {
                    onsets += 1
                    precondition(elapsed >= 0.12 && elapsed < 0.12 + seconds + 0.000001)
                }
            }
            precondition(onsets == 1)
        }
        var clicks = VoiceActivity()
        for _ in 0..<20 {
            precondition(!clicks.observe(rms: 0.2, seconds: 0.04))
            precondition(!clicks.observe(rms: 0.001, seconds: 0.04))
        }
        for seconds in [0.0, -1.0, Double.nan, Double.infinity] {
            precondition(!clicks.observe(rms: 0.5, seconds: seconds))
        }
        precondition(!clicks.observe(rms: Double.infinity, seconds: 1))
        // An energy detector still accepts sustained loud noise. Keep that limit
        // explicit; these tests do not establish echo rejection or speech identity.
        var noise = VoiceActivity()
        precondition(noise.observe(rms: 0.03, seconds: 0.13))
        print("PASS onset: quiet rejection, buffer-duration bounds at four rates, isolated clicks, one event per utterance, reset and invalid samples. Sustained noise/echo classification remains an acoustic check.")
    }
}
