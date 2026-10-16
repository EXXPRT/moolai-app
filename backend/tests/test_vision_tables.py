"""Synthetic image-evidence contracts, not claims about model/image accuracy."""
import copy
import json

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import VisionInput
from moolai_backend.settings import Settings
from moolai_backend.vision_tables import validate_table_vision


def observation(**changes):
    return {
        'field': 'Delta Maximum Pressure', 'status': 'readable', 'value': '12',
        'label': 'Maximum Pressure (kPa)',
        'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Duration (days)\nAlpha | 8 | 2\nDelta | 12 | 14\nOmega | 6 | 1',
        'tableSupport': {'dataRow': 2, 'delimiter': '|', 'valueColumn': 1, 'rowLabelColumn': 0},
        **changes,
    }


def raw(item):
    return json.dumps({'observations': [item], 'interpretation': '', 'scene': None})


@pytest.mark.parametrize('question', [
    'Read Delta Maximum Pressure.', 'What is the maximum pressure for Delta?',
    'Please show me table contents.', 'Extract all table cells.',
])
def test_selected_row_and_visible_header_units_survive_variable_row_extraction(question):
    original = raw(observation())
    result = validate_table_vision(original, question)
    assert result.validated and result.raw == original
    assert result.observations[0].value == '12'
    assert result.observations[0].sourceExcerpt == 'Part | Maximum Pressure (kPa) | Duration (days)\nDelta | 12 | 14'
    assert 'tableSupport' not in result.observations[0].model_dump()


@pytest.mark.parametrize('changes', [
    {'sourceExcerpt': 'Delta | 12 | 14', 'tableSupport': None},
    {'sourceExcerpt': 'Delta | 12 | 14'},
    {'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Duration (days)\nDelta | 12 | 14',
     'tableSupport': {'dataRow': 3, 'delimiter': '|', 'valueColumn': 1, 'rowLabelColumn': 0}},
    {'label': 'Pressure'},
    {'value': '12 kPa'},
    {'value': '14'},
    {'field': 'Delta Minimum Pressure'},
    {'field': 'Alpha Maximum Pressure'},
    {'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Duration (days)\nAlpha | 8 | 2\nDelta | 12\nOmega | 6 | 1'},
    {'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Duration (days)\nDelta | 8 | 2\nDelta | 12 | 14'},
    {'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Maximum Pressure (kPa)\nAlpha | 8 | 2\nDelta | 12 | 14'},
    {'sourceExcerpt': 'Part | Maximum Pressure (kPa) | Duration (days)\nAlpha | 8 | 2\nDelta | | 14'},
])
def test_row_only_wrong_column_qualifier_or_header_never_supplies_a_value(changes):
    original = raw(observation(**changes))
    result = validate_table_vision(original, 'Read Delta Maximum Pressure.')
    assert result.raw == original and not result.validated
    assert result.observations[0].value is None and result.validationErrors


@pytest.mark.parametrize('question', ['Read Alpha Maximum Pressure.', 'Read Delta Minimum Pressure.', 'Read Delta Duration.', 'What is the pressure?',
    'Read Delta Minimum Pressure, not Maximum Pressure.', 'Read Alpha Maximum Pressure; do not use Delta.',
    "Read Delta Duration; don't read Maximum Pressure."])
def test_unrequested_or_ambiguous_cell_is_not_an_answer_value(question):
    result = validate_table_vision(raw(observation()), question)
    assert not result.validated and result.observations[0].value is None


@pytest.mark.parametrize('value', ['-5', '>90%', '12.5', '12 mg'])
def test_signs_comparisons_and_literal_units_are_not_reconstructed(value):
    item = observation(value=value, label='Pressure', field='Delta Pressure',
        sourceExcerpt=f'Part\tPressure\nDelta\t{value}',
        tableSupport={'dataRow': 1, 'delimiter': '\t', 'valueColumn': 1, 'rowLabelColumn': 0})
    result = validate_table_vision(raw(item), 'Read Delta Pressure.')
    assert result.validated and result.observations[0].value == value


@pytest.mark.parametrize('status', ['absent', 'unreadable'])
def test_unavailable_field_cannot_be_repaired_with_nearby_footer_or_table(status):
    item = observation(status=status, value='R-619', field='Batch lot', label='Receipt', sourceExcerpt='Receipt: R-619', tableSupport=None)
    result = validate_table_vision(raw(item), 'What is the batch lot?')
    assert not result.validated and all(item.value is None for item in result.observations)
    clean = validate_table_vision(raw({**item, 'value': None}), 'What is the batch lot?')
    if status == 'absent':
        assert not clean.validated and not clean.observations
    else:
        assert clean.validated and clean.observations[0].value is None


def test_duplicate_keys_are_unvalidated_and_raw_is_preserved():
    original = raw(observation()).replace('"value": "12"', '"value": "12", "value": "99"')
    result = validate_table_vision(original, 'Read Delta Maximum Pressure.')
    assert not result.validated and result.observations == [] and result.raw == original


async def test_production_ocr_calls_same_model_once_with_loaded_header_instruction():
    settings = Settings(nebius_api_key='fixture')
    requests = []
    def respond(request):
        requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.ocr_model}]})
        payload = json.loads(request.content)
        assert payload['model'] == settings.ocr_model and payload['max_completion_tokens'] == 1600
        assert payload['reasoning_effort'] == 'low'
        policy = payload['messages'][0]['content']
        assert 'the question cannot provide missing image text' in policy.lower()
        assert 'tableSupport.headers' in policy and 'tableSupport.row' in policy
        assert 'headers' in policy and 'rowLabelColumn' in policy
        assert 'Set label and sourceExcerpt to null' in policy
        # The observed regression had a schema in prose but no constrained wire
        # output, so MiniCPM silently omitted tableSupport altogether.
        assert 'Schema:' not in policy
        output = payload['response_format']
        assert output['type'] == 'json_schema'
        assert output['json_schema']['name'] == 'ocr_evidence'
        assert output['json_schema']['strict'] is True
        definition = output['json_schema']['schema']['$defs']['HeaderTableObservation']
        assert 'tableSupport' in definition['required']
        assert payload.get('chat_template_kwargs') is None
        assert payload['messages'][1]['content'][0]['text'] == 'Read Delta Maximum Pressure.'
        return httpx.Response(200, json={'model': settings.ocr_model, 'choices': [{
            'finish_reason': 'stop', 'message': {'content': raw(observation())}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(settings, client)).vision(VisionInput(
            question='Read Delta Maximum Pressure.', image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert result.validated and result.observations[0].value == '12'
    assert [request.method for request in requests] == ['GET', 'POST']


def header_observation(**changes):
    return observation(field='West target latency', label='Target latency (ms)', value='<=40', sourceExcerpt=None,
        tableSupport={'headers': ['Region', 'Target latency (ms)', 'Observed latency (ms)', 'Status'],
            'row': ['West', '<=40', '52', 'provisional'], 'valueColumn': 1, 'rowLabelColumn': 0}, **changes)


def test_explicit_visible_headers_and_row_normalize_into_public_evidence_without_inventing_units():
    original = raw(header_observation())
    result = validate_table_vision(original, 'Read West target latency.')
    assert result.validated and result.raw == original
    assert result.observations[0].model_dump() == {'field': 'West target latency', 'status': 'readable',
        'label': 'Target latency (ms)', 'value': '<=40',
        'sourceExcerpt': 'Region\tTarget latency (ms)\tObserved latency (ms)\tStatus\nWest\t<=40\t52\tprovisional'}


@pytest.mark.parametrize('label', [None, 'West', 'Target latency (ms)'])
def test_table_display_label_comes_from_copied_header_not_redundant_label_role(label):
    item = header_observation()
    item['label'] = label
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert result.validated and result.raw == original
    assert result.observations[0].label == 'Target latency (ms)'
    assert result.observations[0].value == '<=40'


@pytest.mark.parametrize('label', ['Observed latency (ms)', 'East', 'Target', 'Region', ''])
def test_table_normalization_does_not_repair_a_wrong_column_or_unrelated_label(label):
    item = header_observation()
    item['label'] = label
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert not result.validated and result.raw == original
    assert result.observations[0].value is None


@pytest.mark.parametrize('change', [
    {'value': '52'}, {'field': 'East target latency'}, {'field': 'West observed latency'},
    {'tableSupport': {'headers': ['Region', '', 'Observed latency (ms)', 'Status'],
                      'row': ['West', '<=40', '52', 'provisional'], 'valueColumn': 1, 'rowLabelColumn': 0}},
])
def test_null_display_label_cannot_bypass_value_row_field_or_header_checks(change):
    item = {**header_observation(), 'label': None, **change}
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert not result.validated and result.raw == original
    assert all(observation.value is None for observation in result.observations)


@pytest.mark.parametrize('change', [
    {'headers': ['Region', 'Target latency (ms)', 'Observed latency (ms)']},
    {'headers': ['Region', '', 'Observed latency (ms)', 'Status']},
    {'headers': ['Region', 'Target latency (ms)', 'Target latency (ms)', 'Status']},
    {'headers': ['Region', 'Target latency (ms)', 'Observed latency (ms)', 'Status|Invented']},
    {'row': ['East', '<=40', '52', 'provisional']},
    {'row': ['West', '', '52', 'provisional']},
    {'valueColumn': 2}, {'valueColumn': 9}, {'rowLabelColumn': 1},
])
def test_explicit_support_keeps_row_column_blank_and_qualifier_guards(change):
    item = header_observation()
    item['tableSupport'].update(change)
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert not result.validated and result.raw == original
    assert all(item.value is None for item in result.observations)


@pytest.mark.parametrize('excerpt', [
    'Region | Target latency (ms) | Observed latency (ms) | Status\nWest | <=40 | 52 | provisional',
    'Region\tTarget latency (ms)\tObserved latency (ms)\tStatus\nWest\t<=40\t52\tprovisional',
])
def test_identical_redundant_excerpt_is_accepted_and_raw_preserved(excerpt):
    item = header_observation()
    item['sourceExcerpt'] = excerpt
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert result.validated and result.raw == original


@pytest.mark.parametrize('excerpt', [
    'West | <=40 | 52 | provisional',
    'Region | Target latency (ms) | Observed latency (ms) | Status\nWest | <=41 | 52 | provisional',
    'Region | Actual latency (ms) | Observed latency (ms) | Status\nWest | <=40 | 52 | provisional',
])
def test_explicit_headers_do_not_hide_a_conflicting_original_excerpt(excerpt):
    item = header_observation()
    item['sourceExcerpt'] = excerpt
    original = raw(item)
    result = validate_table_vision(original, 'Read West target latency.')
    assert not result.validated and result.raw == original and result.observations[0].value is None
    assert any('contradicts' in issue for issue in result.validationErrors)


@pytest.mark.parametrize('field,question', [('Calibration lot', 'Read Calibration lot; do not use Receipt.'),
    ('Channel 12 pressure', 'Read Channel 12 pressure, if present.')])
def test_requested_absence_is_status_only_without_stripping_legitimate_numeric_labels(field, question):
    item = {'field': field, 'status': 'absent', 'value': None, 'label': None, 'sourceExcerpt': None, 'tableSupport': None}
    result = validate_table_vision(raw(item), question)
    assert result.validated and result.observations[0].field == field and result.observations[0].value is None


@pytest.mark.parametrize('field,label,excerpt', [
    ('Receipt', None, None), ('Calibration lot QA-92', None, None),
    ('Calibration lot', 'Calibration lot', 'Calibration lot: QA-92'),
    ('Receipt: 99432', 'Receipt: 99432', 'Receipt: 99432'),
])
def test_unrequested_or_contradictory_absence_is_removed_but_retained_raw(field, label, excerpt):
    original = raw({'field': field, 'status': 'absent', 'value': None,
        'label': label, 'sourceExcerpt': excerpt, 'tableSupport': None})
    result = validate_table_vision(original, 'Read Calibration lot; do not use Receipt.')
    assert not result.validated and result.observations == [] and result.raw == original


def test_schema_requests_header_cells_instead_of_hidden_freeform_header_requirement():
    from moolai_backend.vision_tables import TableExtraction
    schema = TableExtraction.model_json_schema()
    cell_schema = schema['$defs']['VisibleTableCell']
    assert set(cell_schema['required']) == {'headers', 'row', 'valueColumn', 'rowLabelColumn'}
    assert 'TableSupport' not in schema['$defs']


def test_ocr_wire_schema_requires_explicit_properties_but_allows_header_abstention():
    from moolai_backend.vision_tables import ocr_response_format
    schema = ocr_response_format()['json_schema']['schema']
    def check(value):
        if isinstance(value, dict):
            assert 'default' not in value and 'title' not in value
            if value.get('type') == 'object':
                assert value['additionalProperties'] is False
                assert set(value['required']) == set(value['properties'])
            for child in value.values():
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
    check(schema)
    fields = schema['$defs']['HeaderTableObservation']['properties']
    assert {'type': 'null'} in fields['tableSupport']['anyOf']
    assert {'type': 'null'} in fields['value']['anyOf']
    original = raw({'field': 'West target latency', 'status': 'unreadable', 'value': None,
        'label': None, 'sourceExcerpt': None, 'tableSupport': None})
    result = validate_table_vision(original, 'Read West target latency.')
    assert result.validated and result.raw == original and result.observations[0].value is None


@pytest.mark.parametrize('shape', ['supported', 'legacy_row_only'])
async def test_real_provider_path_preserves_header_units_and_rejects_noncompliant_legacy_shape(shape):
    settings = Settings(nebius_api_key='fixture')
    supported = header_observation()
    supported['tableSupport']['row'] = ['West', '<=40', '52', 'provisional']
    item = supported if shape == 'supported' else {**supported,
        'tableSupport': None, 'sourceExcerpt': 'West | <=40 | 52 | provisional'}
    original = raw(item)
    posts = []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.ocr_model}]})
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={'model': settings.ocr_model, 'choices': [{
            'finish_reason': 'stop', 'message': {'content': original}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(settings, client)).vision(VisionInput(
            question='Read West target latency.', image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert len(posts) == 1 and result.raw == original
    if shape == 'supported':
        assert result.validated and result.observations[0].value == '<=40'
        assert result.observations[0].label == 'Target latency (ms)'
        assert result.observations[0].sourceExcerpt.startswith('Region\tTarget latency (ms)')
    else:
        assert not result.validated and result.observations[0].value is None


async def test_unsupported_structured_ocr_request_fails_once_without_schema_or_model_fallback():
    settings = Settings(nebius_api_key='fixture')
    posts = []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.ocr_model}]})
        posts.append(json.loads(request.content))
        return httpx.Response(400, json={'error': {'message': 'unsupported response_format'}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError):
            await NebiusProvider(Gateway(settings, client)).vision(VisionInput(
                question='Read West target latency.', image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert len(posts) == 1
    assert posts[0]['model'] == settings.ocr_model
    assert posts[0]['response_format']['json_schema']['strict'] is True
