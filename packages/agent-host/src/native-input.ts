import { randomUUID } from "node:crypto";
import type { BrainPort, BrainRecord, Segment } from "../../contracts/src/index.js";

interface TranscriptSink {
  ingest(segment: Segment): Promise<unknown>;
  settleTurn(turnId: string): Promise<unknown>;
  retainDiagnostic?(text: string, message: string): Promise<unknown>;
}

/** Keep local source writes independent of slower routing, while ordering completed turns. */
export class NativeInput {
  private writes: Promise<void> = Promise.resolve();
  private turns: Promise<void> = Promise.resolve();
  constructor(
    private sink: TranscriptSink,
    private onError: (error: unknown) => void,
  ) {}

  ingest(segment: Segment): void {
    this.writes = this.writes
      .then(() => this.sink.ingest(segment))
      .then(() => {})
      .catch(this.onError);
  }
  settleTurn(turnId: string): void {
    const precedingWrites = this.writes;
    this.turns = this.turns
      .then(() => precedingWrites)
      .then(() => this.sink.settleTurn(turnId))
      .then(() => {})
      .catch(this.onError);
  }
  /** Rejected ASR text stays inspectable, but never becomes a routed user command. */
  retainDiagnostic(text: string, message: string): void {
    this.writes = this.writes.then(async () => {
      if (!this.sink.retainDiagnostic) throw new Error("ASR diagnostic storage is unavailable");
      await this.sink.retainDiagnostic(text, message);
    }).catch(this.onError);
  }
  saved(): Promise<void> {
    return this.writes;
  }
  settled(): Promise<void> {
    return this.turns;
  }
}

export async function retainAsrDiagnostic(brain: BrainPort, text: string, message: string): Promise<BrainRecord> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await brain.createRecord({ id, kind: "note", createdAt });
  const source = await brain.upsertSegment(id, {
    id: randomUUID(), turnId: randomUUID(), revision: 1, speaker: "user", text,
    final: false, createdAt,
  });
  const record = await brain.updateRecord(id, source.revision, {
    title: "Speech recognition needs review", error: message,
    quality: "pending", qualityReasons: ["Recognition was not accepted; source is retained without routing or summarization."],
  });
  if (!record) throw new Error("ASR diagnostic metadata could not be saved; source remains stored");
  return record;
}
