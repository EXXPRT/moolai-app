import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  newRecord,
  patchRecord,
  reviseSegment,
  searchRecords,
} from "./records.js";

/** SQLite owns durable state; attachment bytes live beside the database. */
export class SQLiteBrain implements BrainPort {
  private db: DatabaseSync;
  private attachmentDirectory: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.attachmentDirectory = join(directory, "attachments");
    mkdirSync(this.attachmentDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "brain.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  private readRecord(id: string): BrainRecord | undefined {
    const row = this.db.prepare("SELECT data FROM records WHERE id=?").get(id);
    return row ? (JSON.parse(row.data as string) as BrainRecord) : undefined;
  }
  private saveRecord(record: BrainRecord): void {
    this.db
      .prepare(
        "INSERT INTO records(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.id, JSON.stringify(record));
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async createRecord(input: {
    id: string;
    kind: BrainRecord["kind"];
    createdAt: string;
  }): Promise<BrainRecord> {
    return this.transaction(() => {
      const existing = this.readRecord(input.id);
      if (existing) return existing;
      const record = newRecord(input);
      this.saveRecord(record);
      return record;
    });
  }
  async getRecord(id: string): Promise<BrainRecord | undefined> {
    return this.readRecord(id);
  }
  async listRecords(): Promise<BrainRecord[]> {
    return this.db
      .prepare("SELECT data FROM records ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.data as string) as BrainRecord);
  }
  async upsertSegment(id: string, segment: Segment): Promise<BrainRecord> {
    return this.transaction(() => {
      const record = this.readRecord(id);
      if (!record) throw new Error(`Unknown record: ${id}`);
      const updated = reviseSegment(record, segment);
      if (updated !== record) this.saveRecord(updated);
      return updated;
    });
  }
  async updateRecord(
    id: string,
    expectedRevision: number,
    patch: RecordPatch,
  ): Promise<BrainRecord | null> {
    return this.transaction(() => {
      const record = this.readRecord(id);
      if (!record || record.revision !== expectedRevision) return null;
      const updated = patchRecord(record, patch);
      this.saveRecord(updated);
      return updated;
    });
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
    const path = join(this.attachmentDirectory, id);
    // Immutable IDs make retries safe and prevent a failed overwrite from changing prior evidence.
    try {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readFileSync(path).equals(Buffer.from(bytes)))
        throw new Error(
          "Attachment IDs are immutable; use a new ID for changed content",
        );
    }
    const existing = this.db
      .prepare("SELECT mime_type FROM attachments WHERE id=?")
      .get(id);
    if (existing && existing.mime_type !== mimeType)
      throw new Error("An existing attachment cannot change MIME type");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO attachments(id,mime_type,size) VALUES (?,?,?)",
      )
      .run(id, mimeType, bytes.byteLength);
    return { id, mimeType, size: bytes.byteLength };
  }
  async getAttachment(
    id: string,
  ): Promise<{ mimeType: string; bytes: Uint8Array } | undefined> {
    attachmentId(id);
    const row = this.db
      .prepare("SELECT mime_type FROM attachments WHERE id=?")
      .get(id);
    return row
      ? {
          mimeType: row.mime_type as string,
          bytes: new Uint8Array(
            readFileSync(join(this.attachmentDirectory, id)),
          ),
        }
      : undefined;
  }
  async putOperation(operation: PendingOperation): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO operations(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(operation.id, JSON.stringify(operation));
  }
  async listOperations(): Promise<PendingOperation[]> {
    return this.db
      .prepare("SELECT data FROM operations ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.data as string) as PendingOperation);
  }
  async getState<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare("SELECT data FROM state WHERE id=?").get(key);
    return row ? (JSON.parse(row.data as string) as T) : undefined;
  }
  async setState<T>(key: string, value: T): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO state(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  async close(): Promise<void> {
    this.db.close();
  }
}
