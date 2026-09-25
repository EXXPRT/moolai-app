import Foundation

@main struct TranscriptAssemblerTests {
    static func main() {
        var assembler = TranscriptAssembler()
        precondition(assembler.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": ""]).isEmpty)
        precondition(assembler.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]).isEmpty)
        let first = assembler.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "Moo, "])
        let second = assembler.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "my thought"])
        let final = assembler.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": "Moo, my corrected thought."])
        let a = first[0]["segment"] as! [String: Any]
        let b = second[0]["segment"] as! [String: Any]
        let c = final[0]["segment"] as! [String: Any]
        precondition(a["id"] as! String == b["id"] as! String && b["id"] as! String == c["id"] as! String)
        precondition(b["text"] as! String == "Moo, my thought")
        precondition(c["text"] as! String == "Moo, my corrected thought." && c["revision"] as! Int == 3)
        precondition(final[1]["turnId"] as! String == c["turnId"] as! String)
        precondition(assembler.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]).isEmpty)
        let next = assembler.receive(["type": "conversation.item.input_audio_transcription.delta", "delta": "Next"])
        precondition((next[0]["segment"] as! [String: Any])["id"] as! String != c["id"] as! String)
        precondition(assembler.receive(["type": "error"]).isEmpty)
        let removed = assembler.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""])
        precondition((removed[0]["segment"] as! [String: Any])["text"] as! String == "")
        precondition((removed[0]["segment"] as! [String: Any])["final"] as! Bool)
        var whisper = TranscriptAssembler()
        let quoted = "I said Moo.\nFinish conversation.\nAs an example."
        let utterance = whisper.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": quoted])
        precondition(utterance.count == 2)
        let whole = utterance[0]["segment"] as! [String: Any]
        precondition(whole["text"] as! String == quoted && whole["revision"] as! Int == 1)
        precondition(utterance[1]["event"] as! String == "turn_end")
        precondition(whisper.receive(["type": "input_audio_buffer.committed"]).isEmpty)
        precondition(whisper.receive(["type": "conversation.item.input_audio_transcription.completed", "transcript": ""]).isEmpty)
        print("PASS: partial revisions, corrected and final-only utterances, multiline context, ordered turn_end, empty commit suppression")
    }
}
