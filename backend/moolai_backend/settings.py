"""Environment-only credentials; importing the module never reads or logs secrets."""
from dataclasses import dataclass
import os
from typing import Literal


@dataclass(frozen=True)
class Settings:
    backend_token: str = ''
    typesafe_api_key: str = ''
    nebius_api_key: str = ''
    tavily_api_key: str = ''
    nebius_base_url: str = 'https://api.tokenfactory.nebius.com/v1'
    jev_model: str = 'jev-1.13.0'
    summary_model: str = 'nvidia/Nemotron-3_5-Lightning'
    agent_model: str = 'nvidia/Nemotron-3-Ultra-550b-a55b'
    vision_model: str = 'openbmb/MiniCPM-V-4_5'
    # OCR has a separate validated profile; scene identification keeps its model.
    ocr_model: str = 'zai-org/GLM-5.3-Flash'
    ocr_reasoning_effort: Literal['low', 'medium', 'high'] = 'low'
    database_url: str = ''
    max_context_chars: int = 180_000
    # Complete UTF-8 request, including injected tools and response schema.
    # Compatible with 180k characters at four bytes each plus bounded framing.
    agent_max_request_bytes: int = 752_000
    summary_max_completion_tokens: int = 1200
    # Organization includes reasoning and the final structured topic summaries.
    # Keep this independent from standalone summaries and the optional planner.
    # Reasoning plus the structured result; at 8,192, 6 of 13 finalizing passes ran out (19 Oct gate).
    organization_max_completion_tokens: int = 16384
    # Keep the library default stable for frozen experiments. Deployments may
    # explicitly allow more room for Ultra's reasoning and final presentation.
    agent_max_tokens: int = 2400
    # Experimental wires remain opt-in until their frozen quality checks pass.
    thought_organization_format: Literal['units', 'compact', 'units_top_level'] = 'units'

    def __post_init__(self):
        if self.ocr_reasoning_effort not in ('low', 'medium', 'high'):
            raise ValueError('OCR reasoning effort must be low, medium or high')
        if type(self.agent_max_request_bytes) is not int or self.agent_max_request_bytes < 1:
            raise ValueError('Agent request byte limit must be a positive integer')
        if self.thought_organization_format not in ('units', 'compact', 'units_top_level'):
            raise ValueError('Thought organization format must be units, compact or units_top_level')
        if type(self.summary_max_completion_tokens) is not int or not 1200 <= self.summary_max_completion_tokens <= 8192:
            raise ValueError('Summary completion limit must be an integer from 1200 to 8192')
        if type(self.organization_max_completion_tokens) is not int or not 4096 <= self.organization_max_completion_tokens <= 16384:
            raise ValueError('Organization completion limit must be an integer from 4096 to 16384')
        if type(self.agent_max_tokens) is not int or not 2400 <= self.agent_max_tokens <= 8192:
            raise ValueError('Agent completion limit must be an integer from 2400 to 8192')

    @classmethod
    def from_env(cls):
        return cls(
            backend_token=os.getenv('MOOLAI_BACKEND_TOKEN', ''),
            typesafe_api_key=os.getenv('TYPESAFE_API_KEY', ''),
            nebius_api_key=os.getenv('NEBIUS_API_KEY', ''),
            tavily_api_key=os.getenv('TAVILY_API_KEY', ''),
            nebius_base_url=os.getenv('NEBIUS_BASE_URL', cls.nebius_base_url).rstrip('/'),
            jev_model=os.getenv('JEV_MODEL', cls.jev_model),
            summary_model=os.getenv('NEBIUS_SUMMARY_MODEL', cls.summary_model),
            agent_model=os.getenv('NEBIUS_AGENT_MODEL', cls.agent_model),
            vision_model=os.getenv('NEBIUS_VISION_MODEL', cls.vision_model),
            ocr_model=os.getenv('NEBIUS_OCR_MODEL', cls.ocr_model),
            ocr_reasoning_effort=os.getenv('NEBIUS_OCR_REASONING_EFFORT', cls.ocr_reasoning_effort),
            database_url=os.getenv('DATABASE_URL', ''),
            summary_max_completion_tokens=int(os.getenv('NEBIUS_SUMMARY_MAX_TOKENS', cls.summary_max_completion_tokens)),
            organization_max_completion_tokens=int(os.getenv('NEBIUS_ORGANIZATION_MAX_TOKENS', cls.organization_max_completion_tokens)),
            agent_max_tokens=int(os.getenv('NEBIUS_AGENT_MAX_TOKENS', cls.agent_max_tokens)),
            agent_max_request_bytes=int(os.getenv('MOOLAI_AGENT_MAX_REQUEST_BYTES', cls.agent_max_request_bytes)),
            thought_organization_format=os.getenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', cls.thought_organization_format),
        )
