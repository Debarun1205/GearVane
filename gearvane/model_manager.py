"""Local model manager for Ollama, LM Studio, and llama.cpp."""

import json
import logging
import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ModelStatus(Enum):
    NOT_INSTALLED = "not_installed"
    DOWNLOADING = "downloading"
    READY = "ready"
    RUNNING = "running"
    ERROR = "error"


@dataclass
class LocalModel:
    name: str
    provider: str  # ollama, lm_studio, llama_cpp
    size_mb: int = 0
    status: ModelStatus = ModelStatus.NOT_INSTALLED
    path: Optional[str] = None
    last_used: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class OllamaManager:
    """Manages models via Ollama."""

    def __init__(self, base_url: str = "http://localhost:11434"):
        self.base_url = base_url

    def list_models(self) -> List[LocalModel]:
        """List installed Ollama models."""
        try:
            result = subprocess.run(
                ["ollama", "list"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return []

            models = []
            lines = result.stdout.strip().split("\n")[1:]  # Skip header
            for line in lines:
                parts = line.split()
                if len(parts) >= 3:
                    models.append(
                        LocalModel(
                            name=parts[0],
                            provider="ollama",
                            size_mb=self._parse_size(parts[2]),
                            status=ModelStatus.READY,
                        )
                    )
            return models
        except FileNotFoundError:
            logger.warning("Ollama not found")
            return []
        except Exception as e:
            logger.error(f"Failed to list Ollama models: {e}")
            return []

    def pull(self, model_name: str) -> bool:
        """Pull a model from Ollama."""
        try:
            logger.info(f"Pulling Ollama model: {model_name}")
            result = subprocess.run(
                ["ollama", "pull", model_name],
                capture_output=True,
                text=True,
                timeout=600,
            )
            return result.returncode == 0
        except Exception as e:
            logger.error(f"Failed to pull model: {e}")
            return False

    def remove(self, model_name: str) -> bool:
        """Remove an Ollama model."""
        try:
            result = subprocess.run(
                ["ollama", "rm", model_name],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return result.returncode == 0
        except Exception as e:
            logger.error(f"Failed to remove model: {e}")
            return False

    def is_running(self) -> bool:
        """Check if Ollama server is running."""
        try:
            result = subprocess.run(
                ["curl", "-s", f"{self.base_url}/api/tags"],
                capture_output=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False

    def start_server(self) -> bool:
        """Start Ollama server."""
        try:
            subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(2)
            return self.is_running()
        except Exception as e:
            logger.error(f"Failed to start Ollama: {e}")
            return False

    def _parse_size(self, size_str: str) -> int:
        """Parse size string like '1.2GB' to MB."""
        try:
            size_str = size_str.upper()
            if "GB" in size_str:
                return int(float(size_str.replace("GB", "")) * 1024)
            elif "MB" in size_str:
                return int(float(size_str.replace("MB", "")))
            return 0
        except (ValueError, AttributeError):
            return 0


class LMStudioManager:
    """Manages models via LM Studio."""

    def __init__(self, base_url: str = "http://localhost:1234"):
        self.base_url = base_url

    def list_models(self) -> List[LocalModel]:
        """List LM Studio models."""
        try:
            import urllib.request

            with urllib.request.urlopen(f"{self.base_url}/v1/models", timeout=5) as resp:
                data = json.loads(resp.read())
                return [
                    LocalModel(
                        name=m["id"],
                        provider="lm_studio",
                        status=ModelStatus.READY,
                    )
                    for m in data.get("data", [])
                ]
        except Exception as e:
            logger.error(f"Failed to list LM Studio models: {e}")
            return []

    def is_running(self) -> bool:
        """Check if LM Studio server is running."""
        try:
            import urllib.request

            urllib.request.urlopen(f"{self.base_url}/v1/models", timeout=5)
            return True
        except Exception:
            return False


class LlamaCppManager:
    """Manages models via llama.cpp."""

    def __init__(self, models_dir: str = "./models"):
        self.models_dir = models_dir

    def list_models(self) -> List[LocalModel]:
        """List llama.cpp GGUF models."""
        models = []
        try:
            from pathlib import Path

            model_path = Path(self.models_dir)
            if model_path.exists():
                for f in model_path.glob("*.gguf"):
                    size_mb = f.stat().st_size // (1024 * 1024)
                    models.append(
                        LocalModel(
                            name=f.stem,
                            provider="llama_cpp",
                            size_mb=size_mb,
                            status=ModelStatus.READY,
                            path=str(f),
                        )
                    )
        except Exception as e:
            logger.error(f"Failed to list llama.cpp models: {e}")
        return models

    def is_running(self) -> bool:
        """Check if llama.cpp server is running."""
        # Would check for running process
        return False


class ModelManager:
    """Unified manager for all local model providers."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        # Accepts either the model_manager section directly or the whole
        # config, so callers can pass load_config() output unchanged.
        self.config = config or {}
        section = self.config.get("model_manager", self.config)

        self.ollama = OllamaManager(
            section.get("ollama", {}).get("base_url", "http://localhost:11434")
        )
        self.lm_studio = LMStudioManager(
            section.get("lm_studio", {}).get("base_url", "http://localhost:1234")
        )
        self.llama_cpp = LlamaCppManager(section.get("llama_cpp", {}).get("models_dir", "./models"))

    def list_all_models(self) -> List[LocalModel]:
        """List all local models across providers."""
        models = []
        models.extend(self.ollama.list_models())
        models.extend(self.lm_studio.list_models())
        models.extend(self.llama_cpp.list_models())
        return models

    def get_available_models(self) -> List[LocalModel]:
        """Get all ready/running models."""
        return [
            m
            for m in self.list_all_models()
            if m.status in (ModelStatus.READY, ModelStatus.RUNNING)
        ]

    def pull_model(self, provider: str, model_name: str) -> bool:
        """Pull a model from a specific provider."""
        if provider == "ollama":
            return self.ollama.pull(model_name)
        logger.warning(f"Pull not supported for provider: {provider}")
        return False

    def remove_model(self, provider: str, model_name: str) -> bool:
        """Remove a model from a specific provider."""
        if provider == "ollama":
            return self.ollama.remove(model_name)
        logger.warning(f"Remove not supported for provider: {provider}")
        return False

    def get_provider_status(self) -> Dict[str, bool]:
        """Get status of all providers."""
        return {
            "ollama": self.ollama.is_running(),
            "lm_studio": self.lm_studio.is_running(),
            "llama_cpp": self.llama_cpp.is_running(),
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get model statistics."""
        models = self.list_all_models()
        total_size = sum(m.size_mb for m in models)

        by_provider: Dict[str, int] = {}
        for m in models:
            by_provider[m.provider] = by_provider.get(m.provider, 0) + 1

        return {
            "total_models": len(models),
            "total_size_mb": total_size,
            "total_size_gb": round(total_size / 1024, 2),
            "by_provider": by_provider,
            "providers_running": self.get_provider_status(),
        }
