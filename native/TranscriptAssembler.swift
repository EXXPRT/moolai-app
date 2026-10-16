import CoreFoundation
import Foundation

/// Recognition previews replace an utterance's text; legacy deltas append to it.
/// Only a nonempty completed utterance may produce a turn_end for Agent routing.
struct TranscriptAssembler {
    private struct Utterance {
        let segmentID = UUID().uuidString
        let turnID = UUID().uuidString
        let createdAt = ISO8601DateFormatter().string(from: Date())
        var revision = 0
        var serverRevision = 0
        var text = ""

        mutating func output(_ value: String, final: Bool) -> [String: Any] {
            text = value
            revision += 1
            return ["event": "transcript", "segment": [
                "id": segmentID, "turnId": turnID, "revision": revision,
                "speaker": "user", "text": text, "final": final, "createdAt": createdAt,
            ]]
        }
    }

    private var legacy: Utterance?
    private var pending: [String: Utterance] = [:]
    // Socket-scoped tombstones prevent late previews/finals from resurrecting a finished utterance.
    private var completedIDs: Set<String> = []

    mutating func receive(_ event: [String: Any]) -> [[String: Any]] {
        guard let type = event["type"] as? String else { return [] }
        let partial = type == "conversation.item.input_audio_transcription.partial"
        let delta = type == "conversation.item.input_audio_transcription.delta"
        let final = type == "conversation.item.input_audio_transcription.completed"
        let rejected = type == "conversation.item.input_audio_transcription.rejected"
        guard partial || delta || final || rejected else { return [] }

        let identity: String?
        let serverRevision: Int?
        if event["utterance_id"] != nil {
            guard let id = event["utterance_id"] as? String, !id.isEmpty, id.count <= 256,
                let value = event["revision"] as? NSNumber,
                CFGetTypeID(value) != CFBooleanGetTypeID(),
                value.doubleValue.isFinite, value.doubleValue > 0,
                value.doubleValue < Double(Int.max), value.doubleValue.rounded() == value.doubleValue,
                !completedIDs.contains(id) else { return [] }
            identity = id
            serverRevision = value.intValue
        } else {
            // Replacement previews require identity and ordering; unversioned append/final adapters remain supported.
            guard !partial else { return [] }
            identity = nil
            serverRevision = nil
        }

        var utterance = identity.flatMap { pending[$0] } ?? (identity == nil ? legacy : nil) ?? Utterance()
        if let serverRevision {
            guard serverRevision > utterance.serverRevision else { return [] }
            utterance.serverRevision = serverRevision
        }

        if partial || delta {
            let value = partial ? event["transcript"] as? String : event["delta"] as? String
            guard let value, !value.isEmpty else { return [] }
            let output = utterance.output(partial ? value : utterance.text + value, final: false)
            if let identity { pending[identity] = utterance } else { legacy = utterance }
            return [output]
        }

        if let identity {
            pending.removeValue(forKey: identity)
            completedIDs.insert(identity)
        } else { legacy = nil }

        let transcript = event["transcript"] as? String ?? ""
        if rejected || transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Preserve rejected words as diagnostic evidence, but never promote a preview to a final command.
            // Empty commit confirmations without a preceding legacy utterance remain no-ops.
            guard rejected || identity != nil || utterance.revision > 0 else { return [] }
            return reject(&utterance, raw: transcript, reason: event["reason"] as? String ?? "No final speech recognized")
        }

        return [utterance.output(transcript, final: true), ["event": "turn_end", "turnId": utterance.turnID]]
    }

    /// Disconnect/error cannot leave a live preview on screen or route its unfinished words.
    mutating func cancelPending(reason: String) -> [[String: Any]] {
        var outputs: [[String: Any]] = []
        if var utterance = legacy {
            outputs += reject(&utterance, raw: "", reason: reason)
            legacy = nil
        }
        for id in pending.keys.sorted() {
            if var utterance = pending.removeValue(forKey: id) {
                outputs += reject(&utterance, raw: "", reason: reason)
                completedIDs.insert(id)
            }
        }
        return outputs
    }

    private func reject(_ utterance: inout Utterance, raw: String, reason: String) -> [[String: Any]] {
        var outputs: [[String: Any]] = []
        let rejectedText = raw.isEmpty ? utterance.text : raw
        if !rejectedText.isEmpty {
            outputs.append(["event": "asr_diagnostic", "text": rejectedText,
                "message": "Unconfirmed recognition: \(reason)"])
        }
        if utterance.revision > 0 { outputs.append(utterance.output("", final: true)) }
        outputs.append(["event": "recognition_rejected"])
        return outputs
    }
}
