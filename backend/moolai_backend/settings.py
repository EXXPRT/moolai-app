"""Environment-only credentials; importing the module never reads or logs secrets."""
from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    backend_token: str = ''
    typesafe_api_key: str = ''
    nebius_api_key: str = ''
    tavily_api_key: str = ''
    nebius_base_url: str = 'https://api.tokenfactory.nebius.com/v1'
    jev_model: str = 'jev-1.13.0'
    summary_model: str = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'
    agent_model: str = 'nvidia/Nemotron-3-Ultra-550b-a55b'
    vision_model: str = 'openbmb/MiniCPM-V-4_5'
    database_url: str = ''
    max_context_chars: int = 180_000

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
            database_url=os.getenv('DATABASE_URL', ''),
        )
