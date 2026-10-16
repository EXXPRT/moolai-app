"""Narration section addresses survive transport; semantic coverage is checked by the Agent."""
import pytest
from pydantic import ValidationError
from moolai_backend.schemas import AgentReply


def reply(point):
    return AgentReply(text='Complete answer', toolCalls=[], spokenOutline={
        'overview': 'A review of the options.', 'points': [point]})


def test_spoken_sections_round_trip_and_legacy_compatibility():
    point = {'label': 'Options', 'explanation': 'Costs are above 90 units, not exactly 90.', 'sourceSections': [1, 2]}
    assert reply(point).spokenOutline.points[0].model_dump() == point
    legacy = {key: value for key, value in point.items() if key != 'sourceSections'}
    assert reply(legacy).spokenOutline.points[0].model_dump(exclude_none=True) == legacy


@pytest.mark.parametrize('sections', [[], [0], [-1], [True], [1.5], ['1'], [1, 1], list(range(1, 52))])
def test_spoken_sections_reject_invalid_addresses(sections):
    with pytest.raises(ValidationError):
        reply({'label': 'Options', 'explanation': 'A supported explanation.', 'sourceSections': sections})
