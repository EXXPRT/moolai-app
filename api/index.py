"""Vercel's Python entrypoint: the demo gateway, never the local runner."""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
# Vercel's uvicorn runs with log_config=None, so nothing would reach the function logs otherwise.
logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s %(message)s')

from moolai_backend.demo_gateway import create_demo_app  # noqa: E402

app = create_demo_app()  # Never raises; counters are Upstash, or the demo is not live.
