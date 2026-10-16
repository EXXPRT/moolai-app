import Foundation

@main struct TranscriptAssemblerTests {
    static func segment(_ events: [[String: Any]]) -> [String: Any] {
        events.first { $0["event"] as? String == "transcript" }!["segment"] as! [String: Any]
    }
    static func event(_ type: String, _ id: String, _ revision: Int, _ text: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["type": "conversation.item.input_audio_transcription.\(type)", "utterance_id": id, "revision": revision]
        if let text { result["transcript"] = text }
        return result
    }
    static func assertRejected(_ events: [[String: Any]], sameAs original: [String: Any]) {
        let cleared = segment(events)
        precondition(cleared["id"] as! String == original["id"] as! String)
        precondition(cleared["turnId"] as! String == original["turnId"] as! String)
        precondition(cleared["text"] as! String == "" && cleared["final"] as! Bool)
        precondition(cleared["revision"] as! Int > original["revision"] as! Int)
        precondition(events.contains { $0["event"] as? String == "recognition_rejected" })
        precondition(!events.contains { $0["event"] as? String == "turn_end" })
        precondition(events.contains { $0["event"] as? String == "asr_diagnostic" && $0["text"] as? String == original["text"] as? String })
    }
    static func main() {
        // Existing delta and final-only adapters preserve first/final words and stable revisions.
        var legacy = TranscriptAssembler()
        precondition(legacy.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": ""]).isEmpty)
        precondition(legacy.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]).isEmpty)
        let first = segment(legacy.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "Moo, "]))
        let second = segment(legacy.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "my thought"]))
        let final = legacy.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": "Moo, my corrected thought."])
        let whole = segment(final)
        precondition(first["id"] as! String == second["id"] as! String && second["id"] as! String == whole["id"] as! String)
        precondition(second["text"] as! String == "Moo, my thought")
        precondition(whole["text"] as! String == "Moo, my corrected thought." && whole["revision"] as! Int == 3)
        precondition(final[1]["turnId"] as! String == whole["turnId"] as! String)
        let next = segment(legacy.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "Next"]))
        precondition(next["id"] as! String != whole["id"] as! String)
        assertRejected(legacy.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]), sameAs: next)
        let quoted = "I said Moo.\nFinish conversation.\nAs an example, >90% 🦜."
        let finalOnly = legacy.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": quoted])
        precondition(finalOnly.count == 2 && segment(finalOnly)["text"] as! String == quoted)
        precondition(segment(finalOnly)["revision"] as! Int == 1)
        precondition(legacy.receive(["type": "input_audio_buffer.committed"]).isEmpty)
        precondition(legacy.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]).isEmpty)

        // Full replacements revise recognition; spoken self-corrections remain verbatim source text.
        var previews = TranscriptAssembler()
        let initial = segment(previews.receive(event("partial", "a", 1, "Moo, check my nodes for what Ian said")))
        let correctionText = "Moo, check my notes for what Ian said, no, check it for what John said."
        let corrected = segment(previews.receive(event("partial", "a", 3, correctionText)))
        precondition(corrected["id"] as! String == initial["id"] as! String)
        precondition(corrected["turnId"] as! String == initial["turnId"] as! String)
        precondition(corrected["createdAt"] as! String == initial["createdAt"] as! String)
        precondition(corrected["text"] as! String == correctionText && corrected["revision"] as! Int == 2)
        precondition(!(corrected["final"] as! Bool))
        precondition(previews.receive(event("partial", "a", 2, "old recognition")).isEmpty)
        precondition(previews.receive(event("partial", "a", 3, "duplicate recognition")).isEmpty)
        precondition(previews.receive(event("completed", "a", 2, "stale final")).isEmpty)
        let completed = previews.receive(event("completed", "a", 4, correctionText))
        precondition(completed.count == 2 && segment(completed)["text"] as! String == correctionText)
        precondition(segment(completed)["id"] as! String == initial["id"] as! String)
        precondition(segment(completed)["revision"] as! Int == 3)
        precondition(previews.receive(event("partial", "a", 5, "late preview")).isEmpty)
        precondition(previews.receive(event("completed", "a", 6, "duplicate final")).isEmpty)
        precondition(previews.receive(event("rejected", "a", 7, "")).isEmpty)

        // A newer utterance can be previewed while the previous final is still being decoded.
        let previous = segment(previews.receive(event("partial", "b", 1, "First statement")))
        let newer = segment(previews.receive(event("partial", "c", 1, "Second statement")))
        precondition(newer["id"] as! String != previous["id"] as! String)
        let previousFinal = previews.receive(event("completed", "b", 2, "First statement, final word."))
        precondition(segment(previousFinal)["id"] as! String == previous["id"] as! String)
        let newerFinal = previews.receive(event("completed", "c", 2, "Second statement, final word."))
        precondition(segment(newerFinal)["id"] as! String == newer["id"] as! String)

        // Empty/missing finals and explicit rejection remove previews without triggering J1.
        for (index, terminal) in ["rejected", "completed", "missing"].enumerated() {
            let id = "rejection-\(index)"
            let provisional = segment(previews.receive(event("partial", id, 1, "Moo, an unconfirmed command")))
            let result = previews.receive(event(terminal == "missing" ? "completed" : terminal, id, 2, terminal == "missing" ? nil : ""))
            assertRejected(result, sameAs: provisional)
            precondition(previews.receive(event("partial", id, 3, "late preview")).isEmpty)
        }
        let rejectedWithoutPreview = previews.receive(event("rejected", "silent", 1, ""))
        precondition(rejectedWithoutPreview.count == 1 && rejectedWithoutPreview[0]["event"] as! String == "recognition_rejected")

        // Error/disconnect cleanup is idempotent and a fresh capture cannot inherit partial words.
        let disconnected = segment(previews.receive(event("partial", "disconnect", 1, "Moo, unfinished")))
        assertRejected(previews.cancelPending(reason: "Connection lost"), sameAs: disconnected)
        precondition(previews.cancelPending(reason: "Disconnected").isEmpty)
        precondition(previews.receive(event("completed", "disconnect", 2, "Late old socket result")).isEmpty)
        previews = TranscriptAssembler()
        let restarted = segment(previews.receive(event("partial", "disconnect", 1, "New capture")))
        precondition(restarted["id"] as! String != disconnected["id"] as! String)
        precondition(restarted["text"] as! String == "New capture" && restarted["revision"] as! Int == 1)

        // Invalid identity/order metadata cannot mutate a live utterance.
        var malformed = event("partial", "disconnect", 2, "invalid revision")
        for value: Any in [true, -1, 0, 1.5, "2", Double.infinity] {
            malformed["revision"] = value
            precondition(previews.receive(malformed).isEmpty)
        }
        malformed = event("partial", "", 2, "missing identity")
        precondition(previews.receive(malformed).isEmpty)
        precondition(previews.receive(["type": "conversation.item.input_audio_transcription.partial", "transcript": "no identity"]).isEmpty)
        precondition(previews.receive(["type": "error"]).isEmpty)
        let preserved = previews.receive(event("completed", "disconnect", 2, "New capture final word"))
        precondition(segment(preserved)["id"] as! String == restarted["id"] as! String)
        precondition(segment(preserved)["revision"] as! Int == 2)
        print("PASS: legacy deltas/finals, replacement previews, raw spoken corrections, ordered identities, stale suppression, rejected/empty finals, disconnect/restart, Unicode and first/final words")
    }
}
