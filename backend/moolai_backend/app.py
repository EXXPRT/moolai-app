"""One authenticated service; no provider secrets or SDKs in the Agent/UI."""
import secrets
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .providers import Gateway, JevProvider, NebiusProvider, ServiceError, TavilyProvider
from .schemas import (
    Accepted, AcceptInput, AgentReply, ConnectInput, ExtractInput, RecordInput,
    RespondInput, RouteDecision, RouteInput, SearchInput, SearchResults, Summary,
    TagDecision, TagInput, VisionEvidence, VisionInput,
)
from .settings import Settings
from .store import PostgresStore


def create_app(settings: Settings | None = None, http_client: httpx.AsyncClient | None = None, store=None) -> FastAPI:
    settings = settings or Settings.from_env()
    client = http_client or httpx.AsyncClient(limits=httpx.Limits(max_connections=4), trust_env=False)
    gateway = Gateway(settings, client)
    jev, nebius, tavily = JevProvider(gateway), NebiusProvider(gateway), TavilyProvider(gateway)
    records = store if store is not None else PostgresStore(settings.database_url)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        if http_client is None:
            await client.aclose()

    app = FastAPI(title='Moolai Agent backend', version='0.1.0', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ServiceError)
    async def service_error(_request, error):
        return JSONResponse(status_code=error.status, content={'detail': str(error)})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, error):
        # FastAPI's default includes rejected input (potentially a full screenshot).
        return JSONResponse(status_code=422, content={
            'detail': 'Invalid request',
            'fields': [{'path': list(item['loc']), 'reason': item['msg']} for item in error.errors()],
        })

    async def authenticate(authorization: str | None = Header(default=None)):
        if not settings.backend_token:
            raise HTTPException(503, 'Set MOOLAI_BACKEND_TOKEN before using the API')
        if not authorization or not secrets.compare_digest(authorization, f'Bearer {settings.backend_token}'):
            raise HTTPException(401, 'Invalid backend token')

    api = APIRouter(prefix='/v1', dependencies=[Depends(authenticate)])

    @app.get('/health')
    async def health():
        # Liveness only; this makes no provider calls or claims about access.
        return {'status': 'ok', 'service': 'moolai-backend'}

    @api.get('/models')
    async def models():
        requested = {'summary': settings.summary_model, 'agent': settings.agent_model, 'vision': settings.vision_model}
        inventory = {
            'jev': {'model': settings.jev_model, 'configured': bool(settings.typesafe_api_key), 'verified': False},
            'tavily': {'configured': bool(settings.tavily_api_key), 'verified': False},
            'nebius': {'configured': bool(settings.nebius_api_key), 'requested': requested, 'available': [], 'verified': False},
        }
        if settings.nebius_api_key:
            try:
                available = await nebius.models(refresh=True)
                inventory['nebius'].update({
                    'available': sorted(available), 'verified': True,
                    'missing': {role: model for role, model in requested.items() if model not in available},
                })
            except ServiceError as error:
                inventory['nebius']['error'] = str(error)
        return inventory

    @api.post('/route', response_model=RouteDecision, response_model_exclude_none=True)
    async def route(item: RouteInput):
        return await jev.route(item)

    @api.post('/tag', response_model=TagDecision, response_model_exclude_none=True)
    async def tag(item: TagInput):
        return await jev.tag(item)

    @api.post('/connect', response_model=dict[str, float])
    async def connect(item: ConnectInput):
        return await jev.connect(item)

    @api.post('/summarize', response_model=Summary, response_model_exclude_none=True)
    async def summarize(item: RecordInput):
        return await nebius.summarize(item.record)

    @api.post('/respond', response_model=AgentReply, response_model_exclude_none=True)
    async def respond(item: RespondInput):
        return await nebius.respond(item)

    @api.post('/vision', response_model=VisionEvidence)
    async def vision(item: VisionInput):
        return await nebius.vision(item)

    @api.post('/search', response_model=SearchResults)
    async def search(item: SearchInput):
        return SearchResults(results=await tavily.search(item.query))

    @api.post('/extract', response_model=SearchResults)
    async def extract(item: ExtractInput):
        return SearchResults(results=await tavily.extract(item.urls))

    @api.post('/records/accept', response_model=Accepted)
    async def accept(item: AcceptInput):
        return Accepted(revision=await records.accept(item.record, item.operationId))

    app.include_router(api)
    return app


app = create_app()
