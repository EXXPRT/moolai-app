import type {
  Attachment,
  BrainPort,
  BrainRecord,
  BrainQuery,
  RecordRevision,
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
  queryRecords,
  relatedRecords,
  importedHistory,
} from "../../contracts/src/records.js";

/** A separate, in-memory adapter for contract tests and ephemeral development. */
export class MemoryBrain implements BrainPort {
  private records = new Map<string, BrainRecord>();
  private attachments = new Map<
    string,
    { mimeType: string; bytes: Uint8Array }
  >();
  private operations = new Map<string, PendingOperation>();
  private revisions = new Map<string, RecordRevision[]>();
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
    if (result !== record) this.remember(record, result, "capture");
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
    if (result.revision !== record.revision)
      this.remember(
        record,
        result,
        patch.manualFields ? "manual" : "generated",
      );
    this.records.set(id, result);
    return copy(result);
  }
  async search(
    query: string,
    limit: number,
    options?: import("../../contracts/src/index.js").BrainSearchOptions,
  ): Promise<BrainRecord[]> {
    return searchRecords(await this.listRecords(), query, limit, options);
  }
  private remember(
    before: BrainRecord,
    after: BrainRecord,
    reason: RecordRevision["reason"],
  ) {
    const entries = this.revisions.get(before.id) ?? [
      { record: copy(before), reason: "import" as const, at: before.updatedAt },
    ];
    entries.push({ record: copy(after), reason, at: after.updatedAt });
    this.revisions.set(before.id, entries);
  }
  async history(id: string) {
    return copy(this.revisions.get(id) ?? []);
  }
  async importRecord(record: BrainRecord, history: RecordRevision[] = []) {
    const revisions = importedHistory(record, history);
    if (this.records.has(record.id)) throw new Error("Record already exists");
    this.records.set(record.id, copy(record));
    this.revisions.set(record.id, revisions);
  }
  async query(options: BrainQuery) {
    return queryRecords(await this.listRecords(), options);
  }
  async related(id: string) {
    return relatedRecords(await this.listRecords(), id);
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
