"""Versioned application instructions explicitly loaded into provider requests."""
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=8)
def instruction(name: str) -> str:
    if name not in {'agent-retrieval-v1', 'agent-final-v1', 'vision-ocr-v1',
                    'agent-retrieval-v2', 'agent-final-v2', 'agent-retrieval-v3', 'agent-final-v3',
                    'vision-ocr-v2', 'vision-ocr-v3', 'vision-ocr-v4'}:
        raise ValueError('Unknown application instruction')
    text = (Path(__file__).parent / 'instructions' / (name + '.md')).read_text(encoding='utf-8').strip()
    if not text:
        raise ValueError('Empty application instruction')
    return text
