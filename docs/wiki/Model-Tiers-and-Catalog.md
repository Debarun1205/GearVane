# Model Tiers & Catalog

GearVane manages a curated catalog of **50 unique models**, pinned to exact commit revisions and SHA256 checksums, divided across three operational tiers.

---

## The Three-Tier Architecture

```
+-------------------------------------------------------------------------+
|                              GearVane Router                            |
+-------------------------------------------------------------------------+
        |                                 |                               |
        v                                 v                               v
+-------------------+             +---------------+             +--------------------+
|    Local Tier     |             |   Mid Tier    |             |   Frontier Tier    |
|    (19 Models)    |             |  (14 Models)  |             |    (17 Models)     |
|                   |             |               |             |                    |
| • Free & Offline  |             | • Balanced    |             | • Complex logic    |
| • Zero-latency    |             | • Code synth  |             | • Architecture     |
| • Privacy-first   |             | • Diagnostics |             | • Deep refactor    |
+-------------------+             +---------------+             +--------------------+
```

### 1. Local Tier (19 Models)
Intended for quick inline autocompletions, simple docstrings, grammar corrections, and sensitive private codebases:
- **Pre-bundled embedded models**:
  - `smollm2-360m-instruct.q4_k_m`: 0.23 GiB (Apache-2.0)
  - `qwen2.5-coder-0.5b-instruct-q4_0`: 0.42 GiB (Apache-2.0)
- **Installable local models**:
  - `smollm2-1.7b-instruct.q4_k_m`: 1.06 GiB
  - `qwen2.5-1.5b-instruct-q4_k_m`: 1.05 GiB
  - `deepseek-r1-distill-qwen-1.5b-q4_k_m`: 1.12 GiB
  - `llama-3.2-1b-instruct-q4_k_m`: 0.88 GiB
  - `llama-3.2-3b-instruct-q4_k_m`: 2.02 GiB
  - `phi-3.5-mini-instruct-q4_k_m`: 2.39 GiB
  - *Plus 11 additional lightweight SLMs from Ollama, LM Studio, and Hugging Face.*

### 2. Mid Tier (14 Models)
High-performance coding workhorses that handle feature implementation, test generation, and diagnostics:
- **First-boot recommended models**:
  - `qwen2.5-7b-instruct-q4_k_m`: 4.36 GiB (Apache-2.0)
  - `qwen3-8b.q4_k_m`: 4.68 GiB (Apache-2.0)
- **Hosted / Cloud Mid options**:
  - `deepseek-chat` (DeepSeek-V3)
  - `gpt-4o-mini`
  - `claude-3-5-haiku`
  - `gemini-2.0-flash`
  - `mistral-small-3`
  - `qwen-2.5-coder-32b`

### 3. Frontier Tier (17 Models)
State-of-the-art models for architectural planning, security audits, and difficult system debugging:
- `claude-3-7-sonnet` / `claude-3-5-sonnet`
- `gpt-4o` / `o1` / `o3-mini`
- `deepseek-reasoner` (DeepSeek R1)
- `gemini-2.5-pro`
- `qwen-max` / `qwen-plus`

---

## Embedded Models Specification

| Identifier | Parameters | Quantization | Size | License | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `smollm2-360m-instruct.q4_k_m` | 360M | Q4_K_M | 0.23 GiB | Apache-2.0 | Pre-bundled (Offline) |
| `qwen2.5-coder-0.5b-instruct-q4_0` | 490M | Q4_0 | 0.42 GiB | Apache-2.0 | Pre-bundled (Offline) |
| `qwen2.5-7b-instruct-q4_k_m` | 7.6B | Q4_K_M | 4.36 GiB | Apache-2.0 | First-boot Onboarding |
| `qwen3-8b.q4_k_m` | 8.2B | Q4_K_M | 4.68 GiB | Apache-2.0 | First-boot Onboarding |

All four embedded models are licensed under the permissive **Apache 2.0** license, ensuring complete freedom for commercial and personal usage.

---

## Supported Providers

GearVane connects to local runtimes and external AI APIs with secure credential storage via system keychains (`keytar` / `safeStorage`):
- **Local Runtimes**: Embedded llama.cpp, Ollama (`http://localhost:11434`), LM Studio (`http://localhost:1234`)
- **Cloud Providers**: Anthropic, OpenAI, OpenRouter, Google Gemini, DeepSeek, Groq, Mistral, Together AI
