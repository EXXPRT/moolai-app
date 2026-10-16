"""Validate reported table evidence without inventing image text or cells.

Only normalized, supported observations reach the public vision contract. Raw
model output remains available for review; consistency is not image truth.
"""
import json
import re
from typing import Annotated, Literal
from pydantic import Field, ValidationError
from .schemas import VisionEvidence, VisionObservation, WireModel


class TableSupport(WireModel):
    # All indices address the SAME excerpt. Line zero contains the header;
    # dataRow identifies an explicitly selected visible data row beneath it.
    dataRow: int = Field(strict=True, ge=1, le=20)
    delimiter: Literal['|', '\t']
    valueColumn: int = Field(strict=True, ge=0, le=19)
    rowLabelColumn: int = Field(strict=True, ge=0, le=19)


class TableObservation(VisionObservation):
    tableSupport: TableSupport | None = None


class _LegacyTableExtraction(WireModel):
    # OCR has no visual hypotheses. Keeping their schema out of this request
    # removes irrelevant instructions without changing the public result type.
    observations: list[TableObservation] = Field(min_length=1, max_length=30)
    interpretation: str = Field(default='', max_length=8000)
    scene: None = None


class VisibleTableCell(WireModel):
    """Copy visible cells before selecting a value; no headers from the question."""
    headers: list[Annotated[str, Field(max_length=500)]] = Field(min_length=2, max_length=20)
    row: list[Annotated[str, Field(max_length=2000)]] = Field(min_length=2, max_length=20)
    valueColumn: int = Field(strict=True, ge=0, le=19)
    rowLabelColumn: int = Field(strict=True, ge=0, le=19)


class HeaderTableObservation(VisionObservation):
    tableSupport: VisibleTableCell | None = None


class TableExtraction(WireModel):
    # The production adapter requests header/row cells explicitly. Previously the
    # model had to put both into a free-form excerpt while emitting indices in a
    # different property; it repeatedly supplied rows without the header. Keep
    # the older representation readable for retained outputs, not in this schema.
    observations: list[HeaderTableObservation] = Field(min_length=1, max_length=30)
    interpretation: str = Field(default='', max_length=8000)
    scene: None = None


def ocr_response_format() -> dict:
    """Put OCR's shape on the actual completion request, not only in prose.

    The nullable support remains explicit: an unreadable header is a valid
    abstention, never a reason to invent text to satisfy a schema. Retained old
    output can still use the parser defaults; new wire output must name every
    property so the model cannot silently omit the header/row decision.
    """
    schema = TableExtraction.model_json_schema()

    def strict(value):
        if isinstance(value, dict):
            value.pop('default', None)
            value.pop('title', None)
            if value.get('type') == 'object':
                value['required'] = list(value.get('properties', {}))
                value['additionalProperties'] = False
            for child in value.values():
                strict(child)
        elif isinstance(value, list):
            for child in value:
                strict(child)

    strict(schema)
    return {'type': 'json_schema', 'json_schema': {
        'name': 'ocr_evidence', 'schema': schema, 'strict': True,
    }}


def _normalize_header_observation(observation: HeaderTableObservation) -> tuple[TableObservation, list[str]]:
    values = observation.model_dump(exclude={'tableSupport'})
    support = observation.tableSupport
    if support is None:
        return TableObservation(**values), []
    issues = []
    # Delimiters or line breaks inside cells make a lossless, unambiguous public
    # table excerpt impossible. Do not silently split or reassign those cells.
    if any(any(char in cell for char in '\t\r\n|') for cell in support.headers + support.row):
        issues.append('table cells contain unsupported embedded delimiters or line breaks')
    excerpt = '\t'.join(support.headers) + '\n' + '\t'.join(support.row)
    if len(excerpt) > 4000:
        issues.append('visible header and selected row exceed the bounded source excerpt')
    if observation.sourceExcerpt:
        # A redundant raw excerpt may not contradict the explicit copied cells.
        # Accept either supported table delimiter, but require identical cells.
        lines = observation.sourceExcerpt.splitlines()
        delimiter = '\t' if '\t' in observation.sourceExcerpt else '|'
        if len(lines) != 2 or [_cells(line, delimiter) for line in lines] != [support.headers, support.row]:
            issues.append('source excerpt contradicts the explicitly transcribed header or selected row')
    if support.valueColumn < len(support.headers) and support.rowLabelColumn < len(support.row):
        header, row_label = support.headers[support.valueColumn], support.row[support.rowLabelColumn]
        # The copied table and selected indices identify the display label.
        # A row label is a redundant table role, not a competing column claim.
        # Field/row/value alignment still must pass _table_issues below before
        # this projection can supply a usable value. Other labels contradict it.
        if observation.label in (None, header, row_label):
            values['label'] = header
        else:
            issues.append('redundant table label contradicts the selected header or row label')
    values['sourceExcerpt'] = excerpt if not issues else observation.sourceExcerpt
    return TableObservation(**values, tableSupport=TableSupport(dataRow=1, delimiter='\t',
        valueColumn=support.valueColumn, rowLabelColumn=support.rowLabelColumn)), issues


def _nonreadable_issues(observation: TableObservation, question: str) -> list[str]:
    if observation.status == 'readable':
        return []
    generic = set('a an the is are was were be of and or to in on at from with what which how many please read report give tell me my this that screen screenshot shown appears value field number no id identifier identifiers code use only notes other not absent unreadable readable if any complete do it its as for you can could'.split())
    def words(value):
        return set(re.findall(r'[^\W_]+', value.casefold())) - generic
    positive = re.sub(r"\b(?:do not|don't|never|ignore|exclude|without)\b[^.!?;]*", '', question, flags=re.I)
    field_words = words(observation.field)
    issues = []
    if not field_words or not field_words.issubset(words(positive)):
        issues.append('nonreadable observation does not identify a complete requested field')
    if observation.status == 'absent' and (observation.label or observation.sourceExcerpt or observation.tableSupport):
        issues.append('absent field contradicts its supplied visible label or source evidence')
    if observation.status == 'absent' and observation.value is not None:
        issues.append('absent observation supplied a value')
    return issues


def _cells(line: str, delimiter: str) -> list[str]:
    # A Markdown edge pipe is decoration, not a table column. Internal blanks
    # remain columns so missing values cannot shift a neighbouring cell left.
    line = line.strip('\r ')
    if delimiter == '|':
        if line.startswith('|'):
            line = line[1:]
        if line.endswith('|'):
            line = line[:-1]
    return [cell.strip() for cell in line.split(delimiter)]


def _field_phrase(value: str) -> str:
    # Unlike generic label tokenization, a header's comparisons and signs are
    # meaningful: '>10' must not become interchangeable with '<10' or '-10'.
    return ' '.join(value.casefold().split())


def _header_names(header: str) -> set[str]:
    """Exact header phrases, optionally without a recognized terminal unit.

    This is not synonym/qualifier resolution. In particular '(planned)' and
    '(maximum)' cannot disappear just because they are in parentheses. Unknown
    unit annotations require the full header in the field until reviewed.
    """
    names = {_field_phrase(header)}
    match = re.fullmatch(r'(.+?)\s*\(([^()]+)\)\s*', header)
    if match:
        # Unit omission only affects matching the field name, never the value
        # or returned visible label. Preserve spelling, quantities and units.
        units = {'pa', 'kpa', 'mpa', 'bar', 'mbar', 'psi', 'kg', 'g', 'mg', 'µg',
                 'm', 'cm', 'mm', 'km', 'l', 'ml', 's', 'ms', 'sec', 'seconds',
                 'min', 'minutes', 'h', 'hr', 'hours', 'day', 'days', 'hz', 'khz',
                 'mhz', 'v', 'mv', 'a', 'ma', 'w', 'kw', 'j', 'kj', 'n', 'nm',
                 '%', '°c', '°f', 'k'}
        if match[2].strip().casefold() in units:
            names.add(_field_phrase(match[1]))
    return names


def _table_issues(observation: TableObservation) -> list[str]:
    support = observation.tableSupport
    excerpt = observation.sourceExcerpt or ''
    if support is None:
        if '|' in excerpt or '\t' in excerpt:
            return ['table excerpt has no aligned header/row support']
        return []
    if observation.status != 'readable':
        # Non-readable values are handled by the ordinary validator. Do not
        # manufacture a usable cell from a well-formed table description.
        return []
    lines = excerpt.splitlines()
    if not 2 <= len(lines) <= 21:
        return ['table support requires one visible header and one to twenty data rows']
    headers, *rows = [_cells(line, support.delimiter) for line in lines]
    if not 2 <= len(headers) <= 20 or any(len(headers) != len(row) for row in rows):
        return ['table header and every data row must have the same bounded column count']
    if support.dataRow >= len(lines):
        return ['table support points outside its transcribed rows']
    if max(support.valueColumn, support.rowLabelColumn) >= len(headers):
        return ['table support points outside its transcribed columns']
    if support.valueColumn == support.rowLabelColumn:
        return ['table value and identifying row label require separate columns']
    names = [_field_phrase(header) for header in headers]
    if not all(names) or len(set(names)) != len(names):
        return ['empty or duplicate table headers require clarification']
    row_names = [_field_phrase(row[support.rowLabelColumn]) for row in rows]
    if not all(row_names) or len(set(row_names)) != len(row_names):
        return ['empty or duplicate table row labels require clarification']
    row = rows[support.dataRow - 1]
    header, value, row_label = headers[support.valueColumn], row[support.valueColumn], row[support.rowLabelColumn]
    issues = []
    if observation.label != header:
        issues.append('visible label must exactly match the selected column header')
    if observation.value != value or not value:
        issues.append('readable value must exactly match the selected data cell, without invented units')
    field, row_name = _field_phrase(observation.field), _field_phrase(row_label)
    # The row may be named bare ("12 Observed") or qualified by its own column
    # header ("Channel 12 Observed"); the remainder must still be one header.
    prefix = next((name for name in (_field_phrase(headers[support.rowLabelColumn] + ' ' + row_label), row_name)
                   if row_name and field.startswith(name + ' ')), None)
    if prefix is None:
        issues.append('named field must begin with the complete transcribed data row label')
    elif field[len(prefix) + 1:] not in _header_names(header):
        # Shared words such as "pressure" cannot turn the minimum column into
        # the maximum, or planned work into actual work.
        issues.append('named field must match the complete selected header, including qualifiers')
    elif sum(field[len(prefix) + 1:] in _header_names(item) for item in headers) != 1:
        issues.append('named field is ambiguous between transcribed column headers')
    return issues


def _requested_cell(question: str, observation: TableObservation) -> bool:
    """Require explicit row/header support, without a rigid whole-sentence parser.

    Conversational word order is accepted, but partial names/qualifiers do not
    authorize a neighbouring row or column. General requests for all table cells
    are permitted. Unresolved scope remains a visible limitation.
    """
    text = _field_phrase(question)
    if re.fullmatch(r"(?:please )?(?:read|extract|show(?: me)?) (?:all (?:the )?)?table (?:cells|contents)[.!?]?", text):
        return True
    support = observation.tableSupport
    lines = observation.sourceExcerpt.splitlines()
    header = _cells(lines[0], support.delimiter)[support.valueColumn]
    row = _cells(lines[support.dataRow], support.delimiter)[support.rowLabelColumn]
    def mentioned(value):
        return re.search(r'(?<!\w)' + re.escape(_field_phrase(value)) + r'(?!\w)', text) is not None
    # An explicitly excluded row/header is not authorized merely because its
    # words appear in the question. This is a conservative scope check, not an
    # attempt to reinterpret every natural-language comparison.
    excluded = r"(?:\bnot|\bignore|\bexclude|\bexcluding|\bexcept|\b(?:do not|don't|never)\s+(?:read|use|report|select))\s+(?:the\s+)?"
    row_name = re.escape(_field_phrase(row))
    for name in _header_names(header):
        phrase = re.escape(name)
        if re.search(excluded + r'(?:' + row_name + r'\s+)?' + phrase + r'(?!\w)', text):
            return False
    if re.search(excluded + row_name + r'(?!\w)', text):
        return False
    return mentioned(row) and any(mentioned(name) for name in _header_names(header))


def validate_table_vision(raw: str, question: str) -> VisionEvidence:
    # Import lazily to reuse ordinary label/contradiction checks without keeping
    # two public validators or introducing an import-time dependency cycle.
    from .providers import validate_vision, _unambiguous_json
    try:
        payload = _unambiguous_json(raw)
        try:
            extraction = TableExtraction.model_validate(payload)
        except ValidationError:
            extraction = _LegacyTableExtraction.model_validate(payload)
    except (ValidationError, ValueError, TypeError):
        return VisionEvidence(raw=raw, observations=[], interpretation='', validated=False,
            validationErrors=['OCR output is unstructured or does not match the evidence schema.'])
    errors, observations = [], []
    for index, observation in enumerate(extraction.observations):
        issues = []
        if isinstance(observation, HeaderTableObservation):
            observation, issues = _normalize_header_observation(observation)
        nonreadable_issues = _nonreadable_issues(observation, question)
        issues += nonreadable_issues + _table_issues(observation)
        if (observation.status == 'readable' and observation.tableSupport and not issues
                and not _requested_cell(question, observation)):
            issues.append('selected table row and complete field are not explicitly supported by the request')
        if issues:
            errors.append(f'Observation {index + 1}: ' + '; '.join(issues) + '.')
        if nonreadable_issues:
            # Retain the complete conflicting claim in raw; do not present an
            # unrequested/contradictory absence as usable status-only evidence.
            continue
        value = observation.model_dump(exclude={'tableSupport'})
        if issues:
            value['value'] = None
        elif observation.status == 'readable' and observation.tableSupport:
            lines = observation.sourceExcerpt.splitlines()
            # Keep headers/units and the selected row, not unrelated neighbouring
            # rows that have not independently passed observation validation.
            value['sourceExcerpt'] = '\n'.join([lines[0], lines[observation.tableSupport.dataRow]])
        observations.append(value)
    normalized = extraction.model_dump(exclude={'observations'}) | {'observations': observations}
    result = validate_vision(json.dumps(normalized, ensure_ascii=False), 'ocr')
    combined = errors + result.validationErrors
    return result.model_copy(update={'raw': raw, 'validationErrors': combined, 'validated': not combined})
