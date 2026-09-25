import type {
  Attachment,
  BrainPort,
  BrainRecord,
  PendingOperation,
  RecordPatch,
  Segment,
} from "../../contracts/src/index.js";
import {
  attachmentId,
  copy,
  newRecord,
  patchRecord,
  reviseSegment,
  searchRecords,
} from "./records.js";

/** A separate, in-memory adapter for contract tests and ephemeral development. */
export class MemoryBrain implements BrainPort {
  private records = new Map<string, BrainRecord>();
  private attachments = new Map<
    string,
    { mimeType: string; bytes: Uint8Array }
  >();
  private operations = new Map<string, PendingOperation>();
  private state = new Map<string, unknown>();

  async createRecord(input: {
    id: string;
    kind: BrainRecord["kind"];
    createdAt: string;
  }): Promise<BrainRecord> {
    if (!this.records.has(input.id))
      this.records.set(input.id, newRecord(input));
    return copy(this.records.get(input.id)!);
  }
  async getRecord(id: string): Promise<BrainRecord | undefined> {
    return copy(this.records.get(id));
  }
  async listRecords(): Promise<BrainRecord[]> {
    return copy([...this.records.values()]);
  }
  async upsertSegment(id: string, segment: Segment): Promise<BrainRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown record: ${id}`);
    const result = reviseSegment(record, segment);
    this.records.set(id, result);
    return copy(result);
  }
  async updateRecord(
    id: string,
    expectedRevision: number,
    patch: RecordPatch,
  ): Promise<BrainRecord | null> {
    const record = this.records.get(id);
    if (!record || record.revision !== expectedRevision) return null;
    const result = patchRecord(record, patch);
    this.records.set(id, result);
    return copy(result);
  }
  async search(query: string, limit: number, options?: import("../../contracts/src/index.js").BrainSearchOptions): Promise<BrainRecord[]> {
    return searchRecords(await this.listRecords(), query, limit, options);
  }
  async putAttachment(
    id: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Attachment> {
    attachmentId(id);
    const existing = this.attachments.get(id);
    if (
      existing &&
      (existing.mimeType !== mimeType ||
        !Buffer.from(existing.bytes).equals(Buffer.from(bytes)))
    ) {
      throw new Error(
        "Attachment IDs are immutable; use a new ID for changed content",
      );
    }
    this.attachments.set(id, { mimeType, bytes: copy(bytes) });
    return { id, mimeType, size: bytes.byteLength };
  }
  async getAttachment(
    id: string,
  ): Promise<{ mimeType: string; bytes: Uint8Array } | undefined> {
    attachmentId(id);
    return copy(this.attachments.get(id));
  }
  async putOperation(operation: PendingOperation): Promise<void> {
    this.operations.set(operation.id, copy(operation));
  }
  async listOperations(): Promise<PendingOperation[]> {
    return copy([...this.operations.values()]);
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return copy(this.state.get(key)) as T | undefined;
  }
  async setState<T>(key: string, value: T): Promise<void> {
    this.state.set(key, copy(value));
  }
  async close(): Promise<void> {
    /* No resources to release. */
  }
}
