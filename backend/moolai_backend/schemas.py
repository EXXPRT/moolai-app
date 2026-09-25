"""Wire types mirror packages/contracts. Invalid output is an error, never a guess."""
import base64
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Identifier = Annotated[str, Field(min_length=1, max_length=200)]
Purpose = Literal['Question', 'Reference', 'Idea', 'Action']
Route = Literal['start_agent', 'end_agent', 'continue_agent', 'offer_help', 'dictate', 'no_action', 'unclear']


class WireModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Segment(WireModel):
    id: Identifier
    turnId: Identifier
    revision: int = Field(ge=0)
    speaker: Literal['user', 'assistant', 'system']
    text: str = Field(max_length=100_000)
    final: bool
    createdAt: str = Field(max_length=100)


class RelatedLink(WireModel):
    targetId: Identifier
    provenance: Literal['suggested', 'source', 'reply']


class OffTopic(WireModel):
    subject: str = Field(min_length=1, max_length=500)


class BrainRecord(WireModel):
    id: Identifier
    kind: Literal['session', 'dictation', 'conversation', 'note']
    revision: int = Field(ge=0)
    sourceRevision: int = Field(ge=0)
    createdAt: str = Field(max_length=100)
    updatedAt: str = Field(max_length=100)
    segments: list[Segment] = Field(max_length=10_000)
    title: str = Field(max_length=2_000)
    summary: str = Field(max_length=100_000)
    summarySourceRevision: int | None = Field(default=None, ge=0)
    purpose: Purpose | None = None
    topics: list[Annotated[str, Field(max_length=200)]] = Field(max_length=100)
    offTopic: OffTopic | None = None
    quality: Literal['pending', 'ready', 'needs_review']
    qualityReasons: list[str] = Field(max_length=100)
    doubt: bool
    links: list[RelatedLink] = Field(max_length=1000)
    attachmentIds: list[Identifier] = Field(max_length=1000)
    manualFields: list[str] = Field(max_length=100)
    acceptedRevision: int = Field(ge=0)
    error: str | None = Field(default=None, max_length=2000)


class HelpOffer(WireModel):
    kind: Literal['help']
    recordId: Identifier
    sourceRevision: int | None = Field(default=None, ge=0)
    screenQuestion: str | None = Field(default=None, max_length=100_000)


class GeneralHelpOffer(WireModel):
    kind: Literal['general_help']
    recordId: Identifier
    sourceRevision: int | None = Field(default=None, ge=0)
    screenQuestion: str | None = Field(default=None, max_length=100_000)


class ClarificationOffer(WireModel):
    kind: Literal['clarification']
    recordId: Identifier
    sourceRevision: int | None = Field(default=None, ge=0)
    screenQuestion: str | None = Field(default=None, max_length=100_000)


class EndWorkOffer(WireModel):
    kind: Literal['end_work']


class CloseOffer(WireModel):
    kind: Literal['close']
    conversationId: Identifier
    sessionId: Identifier
    turnId: Identifier
    revisionKey: str = Field(min_length=1, max_length=8000)
    question: Literal['Shall I close this conversation?']


class RouteInput(WireModel):
    text: str = Field(max_length=60_000)
    recentContext: str = Field(max_length=150_000)
    activeConversation: bool
    pendingOffer: HelpOffer | GeneralHelpOffer | ClarificationOffer | EndWorkOffer | CloseOffer | None = None


class RouteDecision(WireModel):
    route: Route
    confidence: Probability
    helpAccepted: bool | None = None
    screenHelp: bool | None = None
    endAction: Literal['finish', 'cancel', 'continue'] | None = None
    substantiveText: str | None = None
    substantiveContentProbability: Probability | None = None


class TagInput(WireModel):
    record: BrainRecord
    currentSubject: str | None = Field(default=None, max_length=500)
    topicCandidates: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=30)


class TagDecision(WireModel):
    purpose: Purpose | None = None
    purposeConfidence: Probability
    topics: dict[str, Probability]
    doubt: Probability
    relevant: Probability | None = None
    faithful: Probability
    understandable: Probability


class RecordInput(WireModel):
    record: BrainRecord


class ConnectInput(RecordInput):
    candidates: list[BrainRecord] = Field(max_length=5)


class Summary(WireModel):
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=8000)
    topicSuggestion: str | None = Field(default=None, max_length=80)
    topicSuggestions: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=3)


class ToolCall(WireModel):
    id: Identifier
    name: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    arguments: dict[str, Any]


class ChatMessage(WireModel):
    role: Literal['system', 'user', 'assistant', 'tool']
    content: str = Field(max_length=100_000)
    toolCalls: list[ToolCall] | None = Field(default=None, max_length=5)
    toolCallId: Identifier | None = None

    @model_validator(mode='after')
    def tool_fields_match_role(self):
        if self.role == 'tool' and not self.toolCallId:
            raise ValueError('tool messages require toolCallId')
        if self.toolCalls and self.role != 'assistant':
            raise ValueError('only assistant messages can contain toolCalls')
        return self


class ToolDefinition(WireModel):
    name: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    description: str = Field(max_length=1500)
    parameters: dict[str, Any]


class RespondInput(WireModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=300)
    tools: list[ToolDefinition] = Field(max_length=8)
    responseMode: Literal['auto', 'answer_only'] = 'auto'
    closingMode: Literal['current', 'contextual'] = 'current'


class ControlProposal(WireModel):
    action: Literal['end_conversation', 'offer_close']
    reason: str = Field(min_length=1, max_length=1000, pattern=r'\S')


class AgentReply(WireModel):
    text: str = Field(max_length=32_000)
    toolCalls: list[ToolCall] = Field(max_length=5)
    controlProposal: ControlProposal | None = None


class Image(WireModel):
    mimeType: Literal['image/png', 'image/jpeg', 'image/webp']
    dataBase64: str = Field(min_length=4, max_length=8_000_000)

    @field_validator('dataBase64')
    @classmethod
    def valid_base64(cls, value):
        try:
            base64.b64decode(value, validate=True)
        except ValueError as error:
            raise ValueError('image must be base64 encoded') from error
        return value


class VisionInput(WireModel):
    image: Image
    question: str = Field(min_length=1, max_length=2000)
    mode: Literal['ocr', 'visual'] = 'ocr'


class VisionObservation(WireModel):
    field: str = Field(min_length=1, max_length=200)
    status: Literal['readable', 'unreadable', 'absent']
    value: str | None = Field(max_length=2000)
    label: str | None = Field(max_length=500)
    sourceExcerpt: str | None = Field(max_length=4000)


class VisualFeature(WireModel):
    id: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    region: str = Field(min_length=1, max_length=200)


class VisualHypothesis(WireModel):
    label: str = Field(min_length=1, max_length=500)
    featureIds: list[str] = Field(min_length=1, max_length=12)
    confidence: Literal['low', 'medium', 'high']


class VisualScene(WireModel):
    status: Literal['observed', 'absent', 'unclear']
    features: list[VisualFeature] = Field(max_length=12)
    hypotheses: list[VisualHypothesis] = Field(max_length=5)
    limitation: str = Field(max_length=2000)


class VisionExtraction(WireModel):
    """The model supplies observations, never its own validation result."""
    observations: list[VisionObservation] = Field(default_factory=list, max_length=30)
    interpretation: str = Field(default='', max_length=8000)
    scene: VisualScene | None = None


class VisionEvidence(VisionExtraction):
    raw: str = Field(max_length=32_000)
    validationErrors: list[str] = Field(max_length=100)
    validated: bool


class TextResult(WireModel):
    text: str = Field(max_length=32_000)


def public_http_url(value: str) -> str:
    """No local files, credentials or private-address literal extraction requests."""
    import ipaddress
    url = urlsplit(value)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        raise ValueError('URL must be public HTTP(S) without credentials')
    hostname = url.hostname.lower()
    if hostname in ('localhost',) or hostname.endswith(('.local', '.localhost', '.internal')):
        raise ValueError('local addresses are not web sources')
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return value
    if not address.is_global:
        raise ValueError('private addresses are not web sources')
    return value


class SearchInput(WireModel):
    query: str = Field(min_length=1, max_length=1000)


class ExtractInput(WireModel):
    urls: list[Annotated[str, Field(max_length=2000)]] = Field(min_length=1, max_length=3)

    @field_validator('urls')
    @classmethod
    def validate_urls(cls, urls):
        return [public_http_url(url) for url in urls]


class SearchResult(WireModel):
    url: str
    title: str
    content: str


class SearchResults(WireModel):
    results: list[SearchResult]


class AcceptInput(RecordInput):
    operationId: Identifier


class Accepted(WireModel):
    revision: int = Field(ge=0)
