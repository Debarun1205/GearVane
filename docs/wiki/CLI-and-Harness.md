# CLI & Harness Guide

GearVane includes a command-line interface (`@gearvane/cli`) and a Python reference harness (`gearvane` pip package) for headless operation, automated scripts, and CI environments.

---

## TypeScript CLI (`@gearvane/cli`)

### Global Installation & Execution
```bash
# Run directly via npx
npx @gearvane/cli --help

# Or install globally
npm install -g @gearvane/cli
gearvane --help
```

### Core Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `gearvane route` | Classifies and routes a prompt to the optimal model tier | `gearvane route "Write a quick unit test for debounce"` |
| `gearvane models` | Lists all 50 models in the catalog categorized by tier | `gearvane models --tier local` |
| `gearvane benchmark` | Runs local inference latency tests on available hardware | `gearvane benchmark --model qwen2.5-coder-0.5b` |
| `gearvane serve` | Boots the embedded model server on local port | `gearvane serve --port 8080` |
| `gearvane config` | Views or validates the current configuration file | `gearvane config validate` |

---

## Python Reference Harness (`gearvane`)

The repository includes a Python implementation mirroring core classification and routing algorithms.

### Installation
```bash
pip install -e .
```

### Programmatic Usage
```python
from gearvane.router import TierRouter
from gearvane.catalog import load_catalog

router = TierRouter()
catalog = load_catalog()

prompt = "Refactor this distributed consensus engine to avoid deadlocks"
tier, model = router.route(prompt)

print(f"Assigned Tier: {tier}")      # e.g. "frontier"
print(f"Selected Model: {model.id}") # e.g. "claude-3-7-sonnet"
```

---

## Configuration Reference (`gearvane.yaml`)

GearVane reads configuration from `gearvane.yaml` or `.gearvane/config.yaml`:

```yaml
version: 1

routing:
  default_tier: "local"
  fallback_tier: "mid"
  latency_sensitive: true

models:
  preferred_local: "qwen2.5-coder-0.5b-instruct-q4_0"
  preferred_mid: "qwen2.5-7b-instruct-q4_k_m"
  preferred_frontier: "claude-3-7-sonnet"

providers:
  ollama:
    base_url: "http://127.0.0.1:11434"
    enabled: true
  anthropic:
    api_key_env: "ANTHROPIC_API_KEY"

spend_limits:
  per_session: 0.0  # 0.0 indicates unmetered/free default
  per_day: 0.0
```
