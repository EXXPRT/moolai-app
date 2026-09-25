import pytest

from moolai_backend.schemas import BrainRecord


@pytest.fixture
def record():
    return BrainRecord(
        id='note-1', kind='dictation', revision=3, sourceRevision=1,
        createdAt='2026-09-20T00:00:00Z', updatedAt='2026-09-20T00:00:00Z',
        segments=[{
            'id': 'segment-1', 'turnId': 'turn-1', 'revision': 1,
            'speaker': 'user', 'text': 'I think the garden needs more shade. I do not understand why.',
            'final': True, 'createdAt': '2026-09-20T00:00:00Z',
        }], title='Garden shade', summary='User thinks the garden needs more shade and is unsure why.',
        topics=[], quality='pending', qualityReasons=[], doubt=False,
        links=[], attachmentIds=[], manualFields=[], acceptedRevision=0,
    )
