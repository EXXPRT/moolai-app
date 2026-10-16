"""Tie provider work to its HTTP caller; never restart cancelled inference."""
import asyncio
from contextvars import ContextVar
from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import Request
from fastapi.responses import Response

T = TypeVar('T')
_disconnected: ContextVar[asyncio.Event | None] = ContextVar('provider_caller_disconnected', default=None)


async def dispatch_checkpoint() -> None:
    # Let the disconnect watcher consume an already queued disconnect before a
    # second outbound call (for example inventory -> paid completion) starts.
    await asyncio.sleep(0)
    disconnected = _disconnected.get()
    if disconnected is not None and disconnected.is_set():
        raise asyncio.CancelledError('Provider caller disconnected')


async def run_provider_request(request: Request, operation: Callable[[], Awaitable[T]]) -> T | Response:
    # FastAPI has consumed/validated the request body before entering a route.
    # A separate task now owns receive(), so it cannot compete with body parsing.
    disconnected = asyncio.Event()

    async def watch():
        while True:
            if (await request.receive())['type'] == 'http.disconnect':
                disconnected.set()
                return

    token = _disconnected.set(disconnected)
    watcher = asyncio.create_task(watch())
    work = asyncio.create_task(operation())
    try:
        await asyncio.wait((watcher, work), return_when=asyncio.FIRST_COMPLETED)
        if disconnected.is_set():
            # In-flight transport is cancelled too, though an already dispatched
            # provider request may still be billable. Never submit another call.
            work.cancel()
            return Response(status_code=499)
        if watcher.done():
            watcher.result()  # Do not hide an ASGI receive failure.
        return await work
    finally:
        # Server shutdown/handler cancellation has the same dispatch boundary as
        # disconnect, including dependencies that catch CancelledError.
        disconnected.set()
        _disconnected.reset(token)
        for task in (watcher, work):
            if not task.done():
                task.cancel()
        await asyncio.gather(watcher, work, return_exceptions=True)
