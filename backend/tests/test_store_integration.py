"""Real Postgres checks, opt in with TEST_DATABASE_URL pointing at a test database."""
import asyncio
import os
from uuid import uuid4

import psycopg
import pytest

from moolai_backend.providers import ServiceError
from moolai_backend.store import PostgresStore

# Locally the check is opt-in; in GitHub Actions a missing database is a configuration error, not a skip.
if os.getenv('GITHUB_ACTIONS') == 'true' and not os.getenv('TEST_DATABASE_URL'):
    pytest.fail('CI must provide TEST_DATABASE_URL for the real Postgres check', pytrace=False)


@pytest.mark.skipif(not os.getenv('TEST_DATABASE_URL'), reason='TEST_DATABASE_URL is not configured')
async def test_accept_replay_restart_conflict_and_concurrency(record):
    url = os.environ['TEST_DATABASE_URL']
    identifier = 'test-' + str(uuid4())
    operation = identifier + '-op'
    record = record.model_copy(update={'id': identifier})
    store = PostgresStore(url)
    try:
        assert await store.accept(record, operation) == record.revision
        restarted = PostgresStore(url)
        assert await restarted.accept(record, operation) == record.revision
        changed = record.model_copy(update={'summary': 'conflicting content'})
        with pytest.raises(ServiceError) as conflict:
            await restarted.accept(changed, operation)
        assert conflict.value.status == 409
        with pytest.raises(ServiceError):
            await restarted.accept(changed, operation + '-conflict')
        newer = record.model_copy(update={'revision': 5, 'summary': 'newer text'})
        results = await asyncio.gather(*[restarted.accept(newer, operation + '-new') for _ in range(6)])
        assert results == [5] * 6
        with pytest.raises(ServiceError):
            await restarted.accept(record, operation + '-stale')
        # Replaying an earlier successful operation stays idempotent even after a newer revision.
        assert await restarted.accept(record, operation) == 3
        async with await psycopg.AsyncConnection.connect(url) as connection:
            cursor = await connection.execute('SELECT revision, document FROM accepted_records WHERE id = %s', (identifier,))
            revision, document = await cursor.fetchone()
            assert revision == 5 and document['summary'] == 'newer text'
            cursor = await connection.execute('SELECT count(*) FROM accepted_operations WHERE record_id = %s', (identifier,))
            assert (await cursor.fetchone())[0] == 2
    finally:
        async with await psycopg.AsyncConnection.connect(url) as connection:
            await connection.execute('DELETE FROM accepted_operations WHERE record_id = %s', (identifier,))
            await connection.execute('DELETE FROM accepted_records WHERE id = %s', (identifier,))
