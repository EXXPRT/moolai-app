import Foundation

/// Local ASR sends either append-only deltas followed by a corrected final, or a final alone.
/// This identity stays stable across every partial revision of one utterance.
struct TranscriptAssembler {
    private(set) var segmentID = UUID().uuidString
    private(set) var turnID = UUID().uuidString
    private(set) var revision = 0
    private(set) var text = ""
    private(set) var createdAt = ISO8601DateFormatter().string(from: Date())

    mutating func receive(_ event: [String: Any]) -> [[String: Any]] {
        guard let type = event["type"] as? String else { return [] }
        let final = type == "conversation.item.input_audio_transcription.completed"
        guard final || type == "conversation.item.input_audio_transcription.delta" else { return [] }
        // The server emits empty progress deltas and may send an empty final on
        // commit after automatic endpointing. These contain no new transcript.
        if !final && (event["delta"] as? String ?? "").isEmpty { return [] }
        if final && revision == 0 && (event["transcript"] as? String ?? "").isEmpty { return [] }
        if final { text = event["transcript"] as? String ?? text }
        else { text += event["delta"] as? String ?? "" }
        revision += 1
        let segment: [String: Any] = ["id": segmentID, "turnId": turnID, "revision": revision,
            "speaker": "user", "text": text, "final": final, "createdAt": createdAt]
        var result: [[String: Any]] = [["event": "transcript", "segment": segment]]
        if final {
            result.append(["event": "turn_end", "turnId": turnID])
            self = TranscriptAssembler()
        }
        return result
    }
}
