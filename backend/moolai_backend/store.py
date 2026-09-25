"""Accepted backend snapshots, distinct from the Brain's immediate local save."""
import asyncio
import hashlib
import json

import psycopg
from psycopg.types.json import Jsonb

from .providers import ServiceError
from .schemas import BrainRecord


SCHEMA = '''
CREATE TABLE IF NOT EXISTS accepted_records (
    id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    digest TEXT NOT NULL,
    document JSONB NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accepted_operations (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    digest TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
'''


class PostgresStore:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.initialized = False
        self.initialize_lock = asyncio.Lock()

    async def connection(self):
        if not self.database_url:
            raise ServiceError('Backend record storage is not configured', 503)
        return await psycopg.AsyncConnection.connect(self.database_url, connect_timeout=5)

    async def initialize(self):
        async with self.initialize_lock:
            if self.initialized:
                return
            async with await self.connection() as connection:
                await connection.execute(SCHEMA)
            self.initialized = True

    async def accept(self, record: BrainRecord, operation_id: str) -> int:
        document = record.model_dump(exclude_none=True)
        digest = hashlib.sha256(json.dumps(document, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        try:
            await self.initialize()
            async with await self.connection() as connection:
                # Serialize equal operations before equal records. Different records
                # can proceed independently; transaction locks work across API workers.
                await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ('operation:' + operation_id,))
                cursor = await connection.execute(
                    'SELECT record_id, revision, digest FROM accepted_operations WHERE id = %s', (operation_id,))
                existing_operation = await cursor.fetchone()
                if existing_operation:
                    if existing_operation != (record.id, record.revision, digest):
                        raise ServiceError('Operation identity was reused for different content', 409)
                    return existing_operation[1]
                await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ('record:' + record.id,))
                cursor = await connection.execute('SELECT revision, digest FROM accepted_records WHERE id = %s', (record.id,))
                existing = await cursor.fetchone()
                if existing and (existing[0] > record.revision or (existing[0] == record.revision and existing[1] != digest)):
                    raise ServiceError('A newer or conflicting record revision is already accepted', 409)
                await connection.execute('''
                    INSERT INTO accepted_records (id, revision, digest, document)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision,
                        digest = EXCLUDED.digest, document = EXCLUDED.document, accepted_at = now()
                    WHERE accepted_records.revision < EXCLUDED.revision
                ''', (record.id, record.revision, digest, Jsonb(document)))
                await connection.execute('''
                    INSERT INTO accepted_operations (id, record_id, revision, digest)
                    VALUES (%s, %s, %s, %s)
                ''', (operation_id, record.id, record.revision, digest))
                return record.revision
        except psycopg.Error as error:
            # Do not return DSNs, SQL or document values in a user-visible error.
            raise ServiceError('Backend record storage is unavailable; local save remains intact', 503) from error
