"""The demo gateway on 127.0.0.1:8787 for local runs; Vercel serves api/index.py instead.

Provider keys come from backend/.env, read into this process and never printed. Unless .env names
others, Turnstile uses Cloudflare's test keys, counters live in memory and the caps are US$2.
Run from backend/: python -m moolai_backend.demo_local [--upstash]
"""
import logging
import os
import secrets
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .demo_counters import Keys, MemoryCounters
from .demo_gateway import create_demo_app

ENV_FILE = Path(__file__).resolve().parents[1] / '.env'
TEST_SITE_KEY = '1x00000000000000000000AA'
TEST_SECRET = '1x0000000000000000000000000000000AA'
HOST, PORT = '127.0.0.1', 8787


def local_env(base: Mapping[str, str]) -> dict[str, str]:
    env = dict(base)
    env.setdefault('TURNSTILE_SITE_KEY', TEST_SITE_KEY)
    env.setdefault('TURNSTILE_SECRET_KEY', TEST_SECRET)
    env.setdefault('DEMO_SESSION_SECRET', secrets.token_hex(32))
    env.setdefault('DEMO_ENABLED', 'on')
    for name, value in (('DEMO_BUDGET_TOTAL_USD', '2'), ('DEMO_BUDGET_DAILY_USD', '2'),
                        ('DEMO_SESSION_BUDGET_USD', '1')):
        env.setdefault(name, value)
    env['DEMO_ALLOWED_HOSTNAMES'] = 'localhost,127.0.0.1'
    return env


def main(argv: list[str] | None = None) -> None:
    if os.environ.get('VERCEL') or os.environ.get('__VC_HANDLER_ENTRYPOINT'):
        raise SystemExit('demo_local is for local runs only')
    from dotenv import load_dotenv
    # Into os.environ without overriding it, as the plain backend reads it.
    load_dotenv(ENV_FILE, override=False)
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s %(message)s')
    args = sys.argv[1:] if argv is None else argv
    counters = None if '--upstash' in args else MemoryCounters(Keys('local'))
    serve(create_demo_app(local_env(os.environ), counters=counters, local=True))


def serve(app: Any) -> None:
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level='warning', access_log=False, lifespan='on')


if __name__ == '__main__':
    main()
