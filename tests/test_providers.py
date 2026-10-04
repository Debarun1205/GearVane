"""Tests for provider clients and the provider factory."""

import pytest

from waypoint.providers import (
    AnthropicClient,
    OllamaClient,
    OpenAICompatClient,
    ProviderError,
    ProviderFactory,
)
from waypoint.router import ModelProvider


class TestOllamaClient:
    """Ollama /api/generate wire format."""

    def setup_method(self):
        self.client = OllamaClient(base_url="http://localhost:11434", model="llama3.2")

    def test_complete_parses_response(self, monkeypatch):
        captured = {}

        def fake_post(url, payload, headers=None):
            captured["url"] = url
            captured["payload"] = payload
            return {
                "response": "hello there",
                "model": "llama3.2",
                "prompt_eval_count": 12,
                "eval_count": 34,
                "done_reason": "stop",
            }

        monkeypatch.setattr(self.client, "_post", fake_post)
        result = self.client.complete("hi", system="be brief")

        assert captured["url"] == "http://localhost:11434/api/generate"
        assert captured["payload"]["model"] == "llama3.2"
        assert captured["payload"]["stream"] is False
        assert captured["payload"]["system"] == "be brief"
        assert captured["payload"]["options"]["temperature"] == 0.0

        assert result.content == "hello there"
        assert result.usage.tokens_in == 12
        assert result.usage.tokens_out == 34
        assert result.usage.total == 46

    def test_omits_system_when_none(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(
            self.client,
            "_post",
            lambda url, payload, headers=None: captured.update(payload) or {"response": ""},
        )
        self.client.complete("hi")
        assert "system" not in captured

    def test_health_check_detects_models_key(self, monkeypatch):
        monkeypatch.setattr(self.client, "_get", lambda url, headers=None: {"models": []})
        assert self.client.health_check() is True

    def test_health_check_false_on_error(self, monkeypatch):
        def boom(url, headers=None):
            raise ProviderError("down")

        monkeypatch.setattr(self.client, "_get", boom)
        assert self.client.health_check() is False

    def test_list_models(self, monkeypatch):
        monkeypatch.setattr(
            self.client,
            "_get",
            lambda url, headers=None: {"models": [{"name": "llama3.2"}, {"name": "qwen"}]},
        )
        assert self.client.list_models() == ["llama3.2", "qwen"]

    def test_list_models_empty_on_error(self, monkeypatch):
        def boom(url, headers=None):
            raise ProviderError("down")

        monkeypatch.setattr(self.client, "_get", boom)
        assert self.client.list_models() == []


class TestOpenAICompatClient:
    """OpenAI /v1/chat/completions wire format."""

    def setup_method(self):
        self.client = OpenAICompatClient(
            base_url="https://openrouter.ai/api",
            model="anthropic/claude-3-haiku",
            api_key="sk-test",
        )

    def test_complete_parses_response(self, monkeypatch):
        captured = {}

        def fake_post(url, payload, headers=None):
            captured["url"] = url
            captured["payload"] = payload
            return {
                "model": "anthropic/claude-3-haiku",
                "choices": [
                    {
                        "message": {"content": "hi there"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 20},
            }

        monkeypatch.setattr(self.client, "_post", fake_post)
        result = self.client.complete("hello", system="be nice", temperature=0.7)

        assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
        assert captured["payload"]["messages"][0] == {"role": "system", "content": "be nice"}
        assert captured["payload"]["messages"][1] == {"role": "user", "content": "hello"}
        assert captured["payload"]["temperature"] == 0.7

        assert result.content == "hi there"
        assert result.usage.tokens_in == 8
        assert result.usage.tokens_out == 20

    def test_complete_raises_on_empty_choices(self, monkeypatch):
        monkeypatch.setattr(
            self.client, "_post", lambda url, payload, headers=None: {"choices": []}
        )
        with pytest.raises(ProviderError) as exc:
            self.client.complete("hello")
        # An empty choices list is a protocol violation, not a transient fault.
        assert exc.value.retryable is False

    def test_complete_extracts_tool_calls(self, monkeypatch):
        monkeypatch.setattr(
            self.client,
            "_post",
            lambda url, payload, headers=None: {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [{"function": {"name": "search"}}],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )
        result = self.client.complete("hello")
        assert result.content == ""
        assert len(result.tool_calls) == 1
        assert result.finish_reason == "tool_calls"


class TestAnthropicClient:
    """Anthropic /v1/messages wire format."""

    def setup_method(self):
        self.client = AnthropicClient(
            base_url="https://api.anthropic.com",
            model="claude-sonnet-4-20250514",
            api_key="sk-ant-test",
        )

    def test_complete_concatenates_text_blocks(self, monkeypatch):
        captured = {}

        def fake_post(url, payload, headers=None):
            captured["url"] = url
            captured["payload"] = payload
            captured["headers"] = headers
            return {
                "model": "claude-sonnet-4-20250514",
                "content": [
                    {"type": "text", "text": "Hello "},
                    {"type": "text", "text": "world"},
                    {"type": "thinking", "thinking": "ignored"},
                ],
                "usage": {"input_tokens": 5, "output_tokens": 11},
                "stop_reason": "end_turn",
            }

        monkeypatch.setattr(self.client, "_post", fake_post)
        result = self.client.complete("hi", system="sys")

        assert captured["url"] == "https://api.anthropic.com/v1/messages"
        assert captured["headers"]["x-api-key"] == "sk-ant-test"
        assert captured["headers"]["anthropic-version"] == "2023-06-01"
        assert captured["payload"]["system"] == "sys"
        assert captured["payload"]["messages"] == [{"role": "user", "content": "hi"}]

        # Only text blocks are concatenated; thinking blocks are skipped.
        assert result.content == "Hello world"
        assert result.usage.tokens_in == 5
        assert result.usage.tokens_out == 11

    def test_requires_max_tokens(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(
            self.client,
            "_post",
            lambda url, payload, headers=None: captured.update(payload) or {"content": []},
        )
        self.client.complete("hi")
        assert "max_tokens" in captured


class TestProviderFactory:
    """Client construction from router provider entries."""

    def setup_method(self):
        self.factory = ProviderFactory()

    def test_ollama_gets_default_base_url(self):
        provider = ModelProvider(name="ollama", models=["llama3.2"])
        client = self.factory.create(provider)
        assert isinstance(client, OllamaClient)
        assert client.base_url == "http://localhost:11434"
        assert client.model == "llama3.2"

    def test_explicit_base_url_wins(self):
        provider = ModelProvider(
            name="ollama", models=["llama3.2"], base_url="http://gpu-box:11434"
        )
        client = self.factory.create(provider)
        assert client.base_url == "http://gpu-box:11434"

    def test_local_providers_never_carry_api_key(self, monkeypatch):
        # Even with a key in the environment, local servers are unauthenticated.
        monkeypatch.setenv("OLLAMA_API_KEY", "should-be-ignored")
        provider = ModelProvider(name="ollama", models=["llama3.2"])
        client = self.factory.create(provider)
        assert client.api_key is None

    def test_anthropic_maps_to_anthropic_client(self):
        provider = ModelProvider(
            name="anthropic",
            models=["claude-sonnet-4-20250514"],
            api_key_env="ANTHROPIC_API_KEY",
        )
        client = self.factory.create(provider)
        assert isinstance(client, AnthropicClient)
        assert client.base_url == "https://api.anthropic.com"

    def test_openrouter_maps_to_openai_compat(self):
        provider = ModelProvider(
            name="openrouter",
            models=["anthropic/claude-3-haiku"],
            api_key_env="OPENROUTER_API_KEY",
        )
        client = self.factory.create(provider)
        assert isinstance(client, OpenAICompatClient)
        assert client.base_url == "https://openrouter.ai/api"

    def test_api_key_read_from_env(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-real")
        provider = ModelProvider(
            name="anthropic", models=["claude-opus-4"], api_key_env="ANTHROPIC_API_KEY"
        )
        client = self.factory.create(provider)
        assert client.api_key == "sk-ant-real"

    def test_unknown_provider_without_base_url_raises(self):
        provider = ModelProvider(name="some-unknown-cloud", models=["m1"])
        with pytest.raises(ProviderError) as exc:
            self.factory.create(provider)
        assert exc.value.retryable is False
        assert "base_url" in str(exc.value)

    def test_explicit_model_overrides_provider_default(self):
        provider = ModelProvider(name="ollama", models=["a", "b", "c"])
        client = self.factory.create(provider, model="c")
        assert client.model == "c"

    def test_meta_resolves_to_documented_endpoint_and_key(self, monkeypatch):
        monkeypatch.setenv("MODEL_API_KEY", "mk-meta")
        provider = ModelProvider(name="meta", models=["muse-spark-1.3"])
        client = self.factory.create(provider)
        assert isinstance(client, OpenAICompatClient)
        assert client.base_url == "https://api.meta.ai/v1"
        assert client.api_key == "mk-meta"
        assert client.completions_path == "/chat/completions"

    def test_longcat_resolves_to_openai_format_endpoint(self, monkeypatch):
        monkeypatch.setenv("LONGCAT_API_KEY", "lk-longcat")
        provider = ModelProvider(name="longcat", models=["LongCat-2.5-Preview"])
        client = self.factory.create(provider)
        assert isinstance(client, OpenAICompatClient)
        assert client.base_url == "https://api.longcat.chat/openai"
        assert client.api_key == "lk-longcat"

    def test_hosted_endpoint_defaults(self):
        cases = {
            "deepseek": "https://api.deepseek.com",
            "mistral": "https://api.mistral.ai/v1",
            "xai": "https://api.x.ai/v1",
            "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
        }
        for name, base_url in cases.items():
            client = self.factory.create(ModelProvider(name=name, models=["m"]))
            assert client.base_url == base_url, name

    def test_gemini_uses_chat_and_models_paths(self):
        client = self.factory.create(ModelProvider(name="gemini", models=["m"]))
        assert isinstance(client, OpenAICompatClient)
        assert client.completions_path == "/chat/completions"
        assert client.models_path == "/models"

    def test_local_servers_resolve_and_stay_keyless(self, monkeypatch):
        monkeypatch.setenv("LOCALAI_API_KEY", "should-be-ignored")
        cases = {
            "embedded": "http://127.0.0.1:11439",
            "localai": "http://localhost:8080",
            "gpt4all": "http://localhost:4891",
            "textgen": "http://localhost:5000",
        }
        for name, base_url in cases.items():
            client = self.factory.create(ModelProvider(name=name, models=["m"]))
            assert isinstance(client, OpenAICompatClient)
            assert client.base_url == base_url, name
            assert client.api_key is None, name

    def test_explicit_paths_beat_provider_defaults(self):
        provider = ModelProvider(
            name="openai",
            models=["m"],
            base_url="https://proxy.example.com/prefix",
            completions_path="/custom/chat",
            models_path="/custom/models",
        )
        client = self.factory.create(provider)
        assert isinstance(client, OpenAICompatClient)
        assert client.completions_path == "/custom/chat"
        assert client.models_path == "/custom/models"

    def test_default_paths_for_ordinary_providers(self):
        client = self.factory.create(ModelProvider(name="openrouter", models=["m"]))
        assert isinstance(client, OpenAICompatClient)
        assert client.completions_path == "/v1/chat/completions"
        assert client.models_path == "/v1/models"


class TestProviderError:
    """Retryability classification drives the retry layer."""

    def test_retryable_by_default(self):
        assert ProviderError("boom").retryable is True

    def test_non_retryable_flag(self):
        assert ProviderError("bad request", retryable=False).retryable is False
