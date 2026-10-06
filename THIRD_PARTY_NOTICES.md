# Third-party notices

GearVane itself is MIT licensed (see `LICENSE`). This file covers the things GearVane downloads or links to, because their terms differ from ours.

## Model weights

GearVane does not redistribute model weights. It serves weights the user downloads from Hugging Face at the user's request, and the app never uploads or serves anyone else's copy. Each weight keeps its own license, reproduced below from the model's Hugging Face card.

Licences were read from the Hugging Face API `license:` tag on each repository, falling back to the upstream model card where a GGUF repository does not restate the license. Where a repository is gated (Meta Llama, Google Gemma, NVIDIA Nemotron), the license was verified against the upstream model card rather than the third-party GGUF mirror, since the mirror inherits the upstream terms.

The four weights bundled with the installer are Apache-2.0: `qwen2.5-coder-0.5b-instruct-q4_0`, `smollm2-360m-instruct.q4_k_m`, `qwen2.5-7b-instruct-q4_k_m`, `qwen3-8b.q4_k_m`. Nothing with a non-commercial, use-based, or attribution-required license is bundled; those weights are download-on-request only, and the app shows the license beside the download before you commit to it.

### Apache-2.0

- https://www.apache.org/licenses/LICENSE-2.0

| Model | Repository | Size |
| --- | --- | --- |
| `qwen2.5-coder-0.5b-instruct-q4_0` (bundled) | [`Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF) | 0.4 GiB |
| `smollm2-360m-instruct.q4_k_m` (bundled) | [`QuantFactory/SmolLM2-360M-Instruct-GGUF`](https://huggingface.co/QuantFactory/SmolLM2-360M-Instruct-GGUF) | 0.25 GiB |
| `qwen2.5-7b-instruct-q4_k_m` (bundled) | [`bartowski/Qwen2.5-7B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF) | 4.36 GiB |
| `qwen3-8b.q4_k_m` (bundled) | [`QuantFactory/Qwen3-8B-GGUF`](https://huggingface.co/QuantFactory/Qwen3-8B-GGUF) | 4.68 GiB |
| `qwen2.5-1.5b-instruct-q4_0` | [`Qwen/Qwen2.5-1.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) | 0.99 GiB |
| `qwen2.5-coder-1.5b-instruct-q4_0` | [`Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF) | 0.99 GiB |
| `smollm2-1.7b-instruct.q4_k_m` | [`QuantFactory/SmolLM2-1.7B-Instruct-GGUF`](https://huggingface.co/QuantFactory/SmolLM2-1.7B-Instruct-GGUF) | 0.98 GiB |
| `qwen3-0.6b.q4_k_m` | [`QuantFactory/Qwen3-0.6B-GGUF`](https://huggingface.co/QuantFactory/Qwen3-0.6B-GGUF) | 0.45 GiB |
| `tinyllama-1.1b-chat-v1.0.q4_k_m` | [`TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF`](https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF) | 0.62 GiB |
| `qwen2.5-0.5b-instruct-q4_0` | [`Qwen/Qwen2.5-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) | 0.4 GiB |
| `mistral-7b-instruct-v0.3-q4_k_m` | [`bartowski/Mistral-7B-Instruct-v0.3-GGUF`](https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF) | 4.07 GiB |
| `qwen2.5-coder-7b-instruct-q4_0` | [`Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF) | 4.13 GiB |
| `qwen3-1.7b.q4_k_m` | [`QuantFactory/Qwen3-1.7B-GGUF`](https://huggingface.co/QuantFactory/Qwen3-1.7B-GGUF) | 1.19 GiB |
| `qwen3-4b.q4_k_m` | [`QuantFactory/Qwen3-4B-GGUF`](https://huggingface.co/QuantFactory/Qwen3-4B-GGUF) | 2.53 GiB |
| `qwen2.5-14b-instruct-q4_k_m` | [`bartowski/Qwen2.5-14B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF) | 8.37 GiB |
| `mistral-nemo-instruct-2407-q4_k_m` | [`bartowski/Mistral-Nemo-Instruct-2407-GGUF`](https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF) | 6.96 GiB |
| `qwen2.5-coder-14b-instruct-q4_k_m` | [`bartowski/Qwen2.5-Coder-14B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF) | 8.37 GiB |
| `qwen2.5-32b-instruct-q4_k_m` | [`bartowski/Qwen2.5-32B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF) | 17.91 GiB |
| `qwen2.5-coder-32b-instruct-q4_k_m` | [`bartowski/Qwen2.5-Coder-32B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF) | 18.49 GiB |
| `yi-1.5-34b-chat-q4_k_m` | [`bartowski/Yi-1.5-34B-Chat-GGUF`](https://huggingface.co/bartowski/Yi-1.5-34B-Chat-GGUF) | 18.42 GiB |
| `mixtral-8x7b-instruct-q4_k_m` | [`bartowski/Mixtral-8x7B-Instruct-GGUF`](https://huggingface.co/bartowski/Mixtral-8x7B-Instruct-GGUF) | 24.77 GiB |

### BigCode OpenRAIL-M

- https://huggingface.co/spaces/bigcode/bigcode-model-license-agreement

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `starcoder2-7b-q4_k_m` | [`second-state/StarCoder2-7B-GGUF`](https://huggingface.co/second-state/StarCoder2-7B-GGUF) | 4.1 GiB |
| `starcoder2-3b-q4_k_m` | [`second-state/StarCoder2-3B-GGUF`](https://huggingface.co/second-state/StarCoder2-3B-GGUF) | 1.72 GiB |
| `starcoder2-15b-q4_k_m` | [`second-state/StarCoder2-15B-GGUF`](https://huggingface.co/second-state/StarCoder2-15B-GGUF) | 9.18 GiB |

### DeepSeek Model License

- https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL
- https://github.com/deepseek-ai/deepseek-coder/blob/main/LICENSE-MODEL

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `deepseek-coder-1.3b-instruct.q4_k_m` | [`TheBloke/deepseek-coder-1.3b-instruct-GGUF`](https://huggingface.co/TheBloke/deepseek-coder-1.3b-instruct-GGUF) | 0.81 GiB |
| `deepseek-v3-q4_k_m` | [`bartowski/DeepSeek-V3-GGUF`](https://huggingface.co/bartowski/DeepSeek-V3-GGUF) | 67.18 GiB |

### Gemma License

- https://ai.google.dev/gemma/terms

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `gemma-2-2b-it-q4_k_m` | [`bartowski/gemma-2-2b-it-GGUF`](https://huggingface.co/bartowski/gemma-2-2b-it-GGUF) | 1.59 GiB |
| `gemma-2-9b-it-q4_k_m` | [`bartowski/Gemma-2-9B-It-GGUF`](https://huggingface.co/bartowski/Gemma-2-9B-It-GGUF) | 5.1 GiB |
| `gemma-3-27b-q4_k_m` | [`bartowski/Gemma-3-27B-GGUF`](https://huggingface.co/bartowski/Gemma-3-27B-GGUF) | 15.0 GiB |

### Llama 3.1 Community License

- https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `llama-3.1-8b-instruct-q4_k_m` | [`bartowski/Llama-3.1-8B-Instruct-GGUF`](https://huggingface.co/bartowski/Llama-3.1-8B-Instruct-GGUF) | 4.59 GiB |

### Llama 3.2 Community License

- https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `llama-3.2-1b-instruct-q4_k_m` | [`bartowski/Llama-3.2-1B-Instruct-GGUF`](https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF) | 0.75 GiB |
| `llama-3.2-3b-instruct-q4_k_m` | [`bartowski/Llama-3.2-3B-Instruct-GGUF`](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF) | 1.88 GiB |

### Llama 3.3 Community License

- https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `llama-3.3-70b-instruct-q4_k_m` | [`bartowski/Llama-3.3-70B-Instruct-GGUF`](https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF) | 37.29 GiB |

### MIT

- https://opensource.org/license/mit

| Model | Repository | Size |
| --- | --- | --- |
| `deepseek-r1-distill-qwen-1.5b-q4_k_m` | [`bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF`](https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF) | 1.04 GiB |
| `phi-3-mini-4k-instruct-q4` | [`microsoft/Phi-3-mini-4k-instruct-gguf`](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf) | 2.23 GiB |
| `deepseek-r1-distill-qwen-7b-q4_k_m` | [`bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF`](https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF) | 4.36 GiB |
| `deepseek-r1-distill-qwen-14b-q4_k_m` | [`bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF`](https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF) | 8.37 GiB |
| `phi-4-q4_k` | [`microsoft/phi-4-gguf`](https://huggingface.co/microsoft/phi-4-gguf) | 8.43 GiB |
| `deepseek-r1-distill-qwen-32b-q4_k_m` | [`bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF`](https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF) | 18.49 GiB |
| `deepseek-r1-q4_k_m` | [`bartowski/DeepSeek-R1-GGUF`](https://huggingface.co/bartowski/DeepSeek-R1-GGUF) | 12.0 GiB |

### NVIDIA AI Foundation Models License

- https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `nemotron-3-8b-q4_k_m` | [`bartowski/Nemotron-3-8B-GGUF`](https://huggingface.co/bartowski/Nemotron-3-8B-GGUF) | 4.88 GiB |
| `nemotron-3-ultra-q4_k_m` | [`bartowski/Nemotron-3-Ultra-GGUF`](https://huggingface.co/bartowski/Nemotron-3-Ultra-GGUF) | 26.0 GiB |
| `nemotron-4-ultra-q4_k_m` | [`bartowski/Nemotron-4-Ultra-GGUF`](https://huggingface.co/bartowski/Nemotron-4-Ultra-GGUF) | 30.22 GiB |

### Qwen License

- https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/blob/main/LICENSE

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `qwen2.5-72b-instruct-q4_k_m` | [`bartowski/Qwen2.5-72B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-72B-Instruct-GGUF) | 38.4 GiB |

### Qwen Research License

- https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE
- https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct/blob/main/LICENSE

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `qwen2.5-coder-3b-instruct-q4_0` | [`Qwen/Qwen2.5-Coder-3B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF) | 1.86 GiB |
| `qwen2.5-3b-instruct-q4_0` | [`Qwen/Qwen2.5-3B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF) | 1.86 GiB |

### TII Falcon-LLM License 2.0

- https://falconllm.tii.ae/falcon-terms-and-conditions.html

This license is **not** in the bundled set: it is either use-restricted, requires attribution or acceptance of extra terms, or is otherwise outside Apache-2.0/MIT. Read it before use.

| Model | Repository | Size |
| --- | --- | --- |
| `falcon3-3b-instruct-q4_k_m` | [`tiiuae/Falcon3-3B-Instruct-GGUF`](https://huggingface.co/tiiuae/Falcon3-3B-Instruct-GGUF) | 1.87 GiB |
| `falcon3-7b-instruct-q4_k_m` | [`tiiuae/Falcon3-7B-Instruct-GGUF`](https://huggingface.co/tiiuae/Falcon3-7B-Instruct-GGUF) | 4.26 GiB |
| `falcon3-1b-instruct-q4_k_m` | [`tiiuae/Falcon3-1B-Instruct-GGUF`](https://huggingface.co/tiiuae/Falcon3-1B-Instruct-GGUF) | 0.98 GiB |
| `falcon3-10b-instruct-q4_k_m` | [`tiiuae/Falcon3-10B-Instruct-GGUF`](https://huggingface.co/tiiuae/Falcon3-10B-Instruct-GGUF) | 5.86 GiB |


## Trademarks

Model names, repository names, and organization names are the property of their owners. Naming a model here identifies what GearVane can download; it is not a claim of affiliation or endorsement.
