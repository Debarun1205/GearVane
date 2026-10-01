"""Provider clients for local and hosted model APIs.

Only the standard library is used so that the harness has no hard runtime
dependency on an HTTP client. Hosts are discovered through the router's
ModelProvider entries rather than being hardcoded.
"""

import json
import logging
import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)


class ProviderError(Exception):
    """Raised when a provider call fails."""

    def __init__(self, message: str, retryable: bool = True, status_code: Optional[int] = None):
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


@dataclass
class Usage:
    tokens_in: int = 0
    tokens_out: int = 0

    @property
    def total(self) -> int:
        return self.tokens_in + self.tokens_out


@dataclass
class Completion:
    """A model response."""

    content: str
    model: str
    usage: Usage = field(default_factory=Usage)
    raw: Dict[str, Any] = field(default_factory=dict)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    finish_reason: str = "stop"


class ProviderClient:
    """Base class for provider clients."""

    def __init__(
        self, base_url: str, model: str, api_key: Optional[str] = None, timeout: float = 120.0
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Completion:
        raise NotImplementedError

    def stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Iterator[str]:
        raise NotImplementedError

    def health_check(self) -> bool:
        """Cheap availability probe."""
        raise NotImplementedError

    def _post(
        self, url: str, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """POST JSON and decode the JSON response."""
        body = json.dumps(payload).encode("utf-8")
        req_headers = {"Content-Type": "application/json"}
        if headers:
            req_headers.update(headers)
        if self.api_key:
            req_headers.setdefault("Authorization", f"Bearer {self.api_key}")

        request = urllib.request.Request(url, data=body, headers=req_headers, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            # 4xx other than 429 are permanent: retrying will not help.
            retryable = e.code == 429 or e.code >= 500
            raise ProviderError(
                f"HTTP {e.code} from {url}: {detail}",
                retryable=retryable,
                status_code=e.code,
            ) from e
        except urllib.error.URLError as e:
            raise ProviderError(f"Cannot reach {url}: {e.reason}", retryable=True) from e
        except socket.timeout as e:
            raise ProviderError(f"Timeout calling {url}", retryable=True) from e
        except json.JSONDecodeError as e:
            raise ProviderError(f"Invalid JSON from {url}: {e}", retryable=False) from e

    def _get(self, url: str, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        req_headers = {}
        if headers:
            req_headers.update(headers)
        if self.api_key:
            req_headers.setdefault("Authorization", f"Bearer {self.api_key}")

        request = urllib.request.Request(url, headers=req_headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 10.0)) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise ProviderError(f"HTTP {e.code} from {url}", status_code=e.code) from e
        except Exception as e:
            raise ProviderError(f"Cannot reach {url}: {e}") from e


class OllamaClient(ProviderClient):
    """Client for a local Ollama server."""

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Completion:
        payload: Dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if system:
            payload["system"] = system

        data = self._post(f"{self.base_url}/api/generate", payload)

        content = data.get("response", "")
        tokens_in = data.get("prompt_eval_count", 0)
        tokens_out = data.get("eval_count", 0)

        return Completion(
            content=content,
            model=data.get("model", self.model),
            usage=Usage(tokens_in=tokens_in, tokens_out=tokens_out),
            raw=data,
            finish_reason=data.get("done_reason", "stop"),
        )

    def stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Iterator[str]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "stream": True,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if system:
            payload["system"] = system

        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/api/generate",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                for line in resp:
                    if not line.strip():
                        continue
                    chunk = json.loads(line.decode("utf-8"))
                    token = chunk.get("response", "")
                    if token:
                        yield token
                    if chunk.get("done"):
                        break
        except Exception as e:
            raise ProviderError(f"Ollama stream failed: {e}") from e

    def health_check(self) -> bool:
        try:
            data = self._get(f"{self.base_url}/api/tags")
            return "models" in data
        except ProviderError:
            return False

    def list_models(self) -> List[str]:
        """List model names available on this server."""
        try:
            data = self._get(f"{self.base_url}/api/tags")
            return [m.get("name", "") for m in data.get("models", [])]
        except ProviderError:
            return []


class OpenAICompatClient(ProviderClient):
    """Client for any OpenAI-compatible /v1/chat/completions endpoint.

    Covers OpenRouter, Together, Groq, vLLM, LM Studio's OpenAI mode,
    llama.cpp's server, and hosted OpenAI itself.
    """

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Completion:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }

        data = self._post(f"{self.base_url}/v1/chat/completions", payload)

        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(f"No choices in response: {str(data)[:300]}", retryable=False)

        message = choices[0].get("message", {})
        usage_raw = data.get("usage", {}) or {}

        return Completion(
            content=message.get("content", "") or "",
            model=data.get("model", self.model),
            usage=Usage(
                tokens_in=usage_raw.get("prompt_tokens", 0),
                tokens_out=usage_raw.get("completion_tokens", 0),
            ),
            raw=data,
            tool_calls=message.get("tool_calls") or [],
            finish_reason=choices[0].get("finish_reason", "stop"),
        )

    def stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Iterator[str]:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        request = urllib.request.Request(
            f"{self.base_url}/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    token = delta.get("content")
                    if token:
                        yield token
        except Exception as e:
            raise ProviderError(f"OpenAI-compat stream failed: {e}") from e

    def health_check(self) -> bool:
        try:
            data = self._get(f"{self.base_url}/v1/models")
            return "data" in data
        except ProviderError:
            return False

    def list_models(self) -> List[str]:
        try:
            data = self._get(f"{self.base_url}/v1/models")
            return [m.get("id", "") for m in data.get("data", [])]
        except ProviderError:
            return []


class AnthropicClient(ProviderClient):
    """Client for the Anthropic Messages API."""

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Completion:
        payload: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            payload["system"] = system

        headers = {
            "x-api-key": self.api_key or "",
            "anthropic-version": "2023-06-01",
        }
        data = self._post(f"{self.base_url}/v1/messages", payload, headers=headers)

        # Anthropic returns content as a list of blocks.
        blocks = data.get("content", [])
        content = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")

        usage_raw = data.get("usage", {}) or {}

        return Completion(
            content=content,
            model=data.get("model", self.model),
            usage=Usage(
                tokens_in=usage_raw.get("input_tokens", 0),
                tokens_out=usage_raw.get("output_tokens", 0),
            ),
            raw=data,
            finish_reason=data.get("stop_reason", "stop"),
        )

    def stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> Iterator[str]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
        }
        if system:
            payload["system"] = system

        headers = {
            "x-api-key": self.api_key or "",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

        request = urllib.request.Request(
            f"{self.base_url}/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # Anthropic streams typed events.
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta", {})
                        token = delta.get("text")
                        if token:
                            yield token
        except Exception as e:
            raise ProviderError(f"Anthropic stream failed: {e}") from e

    def health_check(self) -> bool:
        # Anthropic has no unauthenticated probe endpoint; a minimal message
        # is the cheapest reliable check.
        try:
            self.complete("ping", max_tokens=1)
            return True
        except ProviderError:
            return False


# Provider name -> client class. Anything not listed falls back to the
# OpenAI-compatible client, which is the most common wire format.
PROVIDER_REGISTRY = {
    "ollama": OllamaClient,
    "lm_studio": OpenAICompatClient,
    "llama_cpp": OpenAICompatClient,
    "llamacpp": OpenAICompatClient,
    "openai": OpenAICompatClient,
    "openrouter": OpenAICompatClient,
    "together": OpenAICompatClient,
    "groq": OpenAICompatClient,
    "vllm": OpenAICompatClient,
    "anthropic": AnthropicClient,
    "claude": AnthropicClient,
}

# Default base URLs for hosted providers.
DEFAULT_BASE_URLS = {
    "ollama": "http://localhost:11434",
    "lm_studio": "http://localhost:1234",
    "llama_cpp": "http://localhost:8080",
    "llamacpp": "http://localhost:8080",
    "openai": "https://api.openai.com",
    "openrouter": "https://openrouter.ai/api",
    "together": "https://api.together.xyz",
    "groq": "https://api.groq.com/openai",
    "vllm": "http://localhost:8000",
    "anthropic": "https://api.anthropic.com",
    "claude": "https://api.anthropic.com",
}


class ProviderFactory:
    """Builds provider clients from router ModelProvider entries."""

    def __init__(self, timeout: float = 120.0):
        self.timeout = timeout

    def create(self, provider, model: Optional[str] = None) -> ProviderClient:
        """Create a client for a router ModelProvider (or a name)."""
        if hasattr(provider, "name"):
            name = provider.name
            base_url = provider.base_url
            api_key_env = provider.api_key_env
        else:
            name = str(provider)
            base_url = None
            api_key_env = None

        normalized = name.lower().strip()

        # An explicit base_url wins; otherwise fall back to the provider default.
        base_url = base_url or DEFAULT_BASE_URLS.get(normalized)
        if not base_url:
            raise ProviderError(
                f"No base_url configured for provider '{name}'. "
                f"Set providers.{name}.base_url in your config.",
                retryable=False,
            )

        # API key comes from the environment only. Never from the config file.
        api_key = None
        if api_key_env:
            api_key = os.environ.get(api_key_env)
        if not api_key:
            for var in (f"{normalized.upper()}_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
                api_key = os.environ.get(var)
                if api_key:
                    break

        if normalized in ("ollama", "lm_studio", "llama_cpp", "llamacpp"):
            # Local servers do not authenticate.
            api_key = None

        client_class = PROVIDER_REGISTRY.get(normalized, OpenAICompatClient)
        target_model = model or (
            provider.models[0] if hasattr(provider, "models") and provider.models else ""
        )

        return client_class(
            base_url=base_url,
            model=target_model,
            api_key=api_key,
            timeout=self.timeout,
        )
