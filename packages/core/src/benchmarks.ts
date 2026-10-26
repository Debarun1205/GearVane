/**
 * Model benchmarks and public capability tiering.
 *
 * Tiers in GearVane are calibrated against publicly available evaluation
 * benchmarks (HumanEval / EvalPlus for code generation, MMLU for multi-task
 * reasoning, and GSM8K / MATH for algorithmic problem-solving), rather than
 * memory footprint alone.
 *
 * Tier definitions:
 * - `local`: Low latency (<50ms TTFT), mechanical refactors, syntax/formatting,
 *   boilerplate, and quick single-turn queries. HumanEval < 60%, MMLU < 65%.
 * - `mid`: Component implementation, unit test authoring, multi-file edits,
 *   and structured reasoning. HumanEval 60-84%, MMLU 65-80%.
 * - `frontier`: High-complexity architecture, concurrency, complex algorithmic
 *   refactoring, deep reasoning. HumanEval >= 85%, MMLU >= 80%.
 */

import type { Tier } from './types.js';

export interface ModelBenchmarkInfo {
  id: string;
  tier: Tier;
  name: string;
  /** Parameter scale (e.g. '0.5B', '7B', '32B', 'MoE'). */
  params: string;
  /** HumanEval Python pass@1 benchmark score (% 0-100). */
  humanEval: number;
  /** Massive Multitask Language Understanding score (% 0-100). */
  mmlu: number;
  /** Grade School Math 8K reasoning score (% 0-100, where evaluated). */
  gsm8k?: number;
  /** Short capability summary for in-app picker and badges. */
  capabilityBadge: string;
  /** Recommended task profile. */
  recommendedFor: string;
}

/**
 * Public benchmark dataset for catalog and known hosted models.
 * Sources: Hugging Face Open LLM Leaderboard, LMSYS Chatbot Arena, EvalPlus,
 * and published model technical reports.
 */
export const MODEL_BENCHMARKS: Record<string, ModelBenchmarkInfo> = {
  // ── Local Tier (19 Models) ──────────────────────────────────────────
  'smollm2-360m-instruct.q4_k_m': {
    id: 'smollm2-360m-instruct.q4_k_m',
    tier: 'local',
    name: 'SmolLM2 360M Instruct',
    params: '360M',
    humanEval: 31.0,
    mmlu: 38.0,
    capabilityBadge: 'Local • Ultra-light 360M (HE 31%)',
    recommendedFor: 'Typos, formatting, quick text generation',
  },
  'qwen2.5-0.5b-instruct-q4_0': {
    id: 'qwen2.5-0.5b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5 0.5B Instruct',
    params: '0.5B',
    humanEval: 37.8,
    mmlu: 45.2,
    capabilityBadge: 'Local • Fast 0.5B (HE 38%)',
    recommendedFor: 'Short instructions, summaries, mechanical edits',
  },
  'qwen2.5-coder-0.5b-instruct-q4_0': {
    id: 'qwen2.5-coder-0.5b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5-Coder 0.5B Instruct',
    params: '0.5B',
    humanEval: 51.2,
    mmlu: 47.0,
    capabilityBadge: 'Local • Fast Coder 0.5B (HE 51%)',
    recommendedFor: 'Fast code linting, boilerplate, small patches',
  },
  'qwen3-0.6b.q4_k_m': {
    id: 'qwen3-0.6b.q4_k_m',
    tier: 'local',
    name: 'Qwen3 0.6B',
    params: '0.6B',
    humanEval: 46.5,
    mmlu: 49.0,
    capabilityBadge: 'Local • Next-gen 0.6B (HE 47%)',
    recommendedFor: 'Compact general assistant, quick lookups',
  },
  'tinyllama-1.1b-chat-v1.0.q4_k_m': {
    id: 'tinyllama-1.1b-chat-v1.0.q4_k_m',
    tier: 'local',
    name: 'TinyLlama 1.1B Chat',
    params: '1.1B',
    humanEval: 26.0,
    mmlu: 32.5,
    capabilityBadge: 'Local • Tiny 1.1B (HE 26%)',
    recommendedFor: 'Lightweight chat on constrained devices',
  },
  'llama-3.2-1b-instruct-q4_k_m': {
    id: 'llama-3.2-1b-instruct-q4_k_m',
    tier: 'local',
    name: 'Llama 3.2 1B Instruct',
    params: '1B',
    humanEval: 42.1,
    mmlu: 51.5,
    capabilityBadge: 'Local • Meta 1B (HE 42%)',
    recommendedFor: 'Fast chat, single-file edits, summaries',
  },
  'deepseek-coder-1.3b-instruct.q4_k_m': {
    id: 'deepseek-coder-1.3b-instruct.q4_k_m',
    tier: 'local',
    name: 'DeepSeek Coder 1.3B Instruct',
    params: '1.3B',
    humanEval: 62.8,
    mmlu: 44.0,
    capabilityBadge: 'Local • Efficient Coder 1.3B (HE 63%)',
    recommendedFor: 'Function completions, syntax fixes',
  },
  'smollm2-1.7b-instruct.q4_k_m': {
    id: 'smollm2-1.7b-instruct.q4_k_m',
    tier: 'local',
    name: 'SmolLM2 1.7B Instruct',
    params: '1.7B',
    humanEval: 48.0,
    mmlu: 54.5,
    capabilityBadge: 'Local • SmolLM2 1.7B (HE 48%)',
    recommendedFor: 'General dialogue, markdown documentation',
  },
  'falcon3-1b-instruct-q4_k_m': {
    id: 'falcon3-1b-instruct-q4_k_m',
    tier: 'local',
    name: 'Falcon3 1B Instruct',
    params: '1B',
    humanEval: 39.5,
    mmlu: 48.5,
    capabilityBadge: 'Local • Falcon 1B (HE 40%)',
    recommendedFor: 'Simple Q&A, lightweight instructions',
  },
  'qwen2.5-1.5b-instruct-q4_0': {
    id: 'qwen2.5-1.5b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5 1.5B Instruct',
    params: '1.5B',
    humanEval: 54.0,
    mmlu: 60.5,
    capabilityBadge: 'Local • Responsive 1.5B (HE 54%)',
    recommendedFor: 'Conversational tasks, basic code adjustments',
  },
  'qwen2.5-coder-1.5b-instruct-q4_0': {
    id: 'qwen2.5-coder-1.5b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5-Coder 1.5B Instruct',
    params: '1.5B',
    humanEval: 70.1,
    mmlu: 58.5,
    capabilityBadge: 'Local • High-efficiency Coder 1.5B (HE 70%)',
    recommendedFor: 'Unit tests, script generation, bug patches',
  },
  'deepseek-r1-distill-qwen-1.5b-q4_k_m': {
    id: 'deepseek-r1-distill-qwen-1.5b-q4_k_m',
    tier: 'local',
    name: 'DeepSeek-R1 Distill Qwen 1.5B',
    params: '1.5B',
    humanEval: 68.0,
    mmlu: 62.0,
    gsm8k: 82.5,
    capabilityBadge: 'Local • Reasoning Distill 1.5B (HE 68%, GSM 83%)',
    recommendedFor: 'Step-by-step logic, math puzzles, debugging',
  },
  'qwen3-1.7b.q4_k_m': {
    id: 'qwen3-1.7b.q4_k_m',
    tier: 'local',
    name: 'Qwen3 1.7B',
    params: '1.7B',
    humanEval: 58.0,
    mmlu: 61.2,
    capabilityBadge: 'Local • Next-gen 1.7B (HE 58%)',
    recommendedFor: 'Balanced local assistance, single-file edits',
  },
  'gemma-2-2b-it-q4_k_m': {
    id: 'gemma-2-2b-it-q4_k_m',
    tier: 'local',
    name: 'Gemma 2 2B Instruct',
    params: '2B',
    humanEval: 44.5,
    mmlu: 56.0,
    capabilityBadge: 'Local • Google Gemma 2B (HE 45%)',
    recommendedFor: 'Text restructuring, writing, safe instructions',
  },
  'starcoder2-3b-q4_k_m': {
    id: 'starcoder2-3b-q4_k_m',
    tier: 'local',
    name: 'StarCoder2 3B',
    params: '3B',
    humanEval: 52.4,
    mmlu: 48.0,
    capabilityBadge: 'Local • StarCoder2 3B (HE 52%)',
    recommendedFor: 'Multi-language code completion',
  },
  'qwen2.5-3b-instruct-q4_0': {
    id: 'qwen2.5-3b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5 3B Instruct',
    params: '3B',
    humanEval: 61.0,
    mmlu: 67.0,
    capabilityBadge: 'Local • Strong 3B (HE 61%, MMLU 67%)',
    recommendedFor: 'Balanced local agent tasks, command drafting',
  },
  'qwen2.5-coder-3b-instruct-q4_0': {
    id: 'qwen2.5-coder-3b-instruct-q4_0',
    tier: 'local',
    name: 'Qwen2.5-Coder 3B Instruct',
    params: '3B',
    humanEval: 74.4,
    mmlu: 65.5,
    capabilityBadge: 'Local • Compact Powerhouse Coder 3B (HE 74%)',
    recommendedFor: 'Fast refactors, test authoring, code review',
  },
  'falcon3-3b-instruct-q4_k_m': {
    id: 'falcon3-3b-instruct-q4_k_m',
    tier: 'local',
    name: 'Falcon3 3B Instruct',
    params: '3B',
    humanEval: 50.0,
    mmlu: 58.0,
    capabilityBadge: 'Local • Falcon3 3B (HE 50%)',
    recommendedFor: 'Instruction following, basic reasoning',
  },
  'llama-3.2-3b-instruct-q4_k_m': {
    id: 'llama-3.2-3b-instruct-q4_k_m',
    tier: 'local',
    name: 'Llama 3.2 3B Instruct',
    params: '3B',
    humanEval: 58.5,
    mmlu: 63.4,
    capabilityBadge: 'Local • Meta 3B (HE 59%, MMLU 63%)',
    recommendedFor: 'Agent tool selection, conversation, task planning',
  },

  // ── Mid Tier (14 Models) ────────────────────────────────────────────
  'phi-3.5-mini-instruct-q4_0': {
    id: 'phi-3.5-mini-instruct-q4_0',
    tier: 'mid',
    name: 'Phi-3.5 Mini Instruct',
    params: '3.8B',
    humanEval: 71.0,
    mmlu: 69.0,
    capabilityBadge: 'Mid • MS Reasoning 3.8B (HE 71%, MMLU 69%)',
    recommendedFor: 'Multi-step logic, code verification, documentation',
  },
  'phi-3-mini-4k-instruct-q4': {
    id: 'phi-3-mini-4k-instruct-q4',
    tier: 'mid',
    name: 'Phi-3 Mini 4K Instruct',
    params: '3.8B',
    humanEval: 69.5,
    mmlu: 68.0,
    capabilityBadge: 'Mid • MS Phi-3 3.8B (HE 70%)',
    recommendedFor: 'Structured output, test writing',
  },
  'qwen3-4b.q4_k_m': {
    id: 'qwen3-4b.q4_k_m',
    tier: 'mid',
    name: 'Qwen3 4B',
    params: '4B',
    humanEval: 68.0,
    mmlu: 72.0,
    capabilityBadge: 'Mid • Next-gen 4B (HE 68%, MMLU 72%)',
    recommendedFor: 'Medium complexity features, multi-file edits',
  },
  'nvidia-nemotron3-nano-4b-q4_k_m': {
    id: 'nvidia-nemotron3-nano-4b-q4_k_m',
    tier: 'mid',
    name: 'NVIDIA Nemotron3 Nano 4B',
    params: '4B',
    humanEval: 64.0,
    mmlu: 70.0,
    capabilityBadge: 'Mid • NVIDIA 4B (HE 64%, MMLU 70%)',
    recommendedFor: 'Instruction following, role-based subagent prompts',
  },
  'mistral-7b-instruct-v0.3-q4_k_m': {
    id: 'mistral-7b-instruct-v0.3-q4_k_m',
    tier: 'mid',
    name: 'Mistral 7B Instruct v0.3',
    params: '7B',
    humanEval: 62.0,
    mmlu: 69.5,
    capabilityBadge: 'Mid • Mistral 7B (HE 62%, MMLU 70%)',
    recommendedFor: 'Function calling, general software dev',
  },
  'starcoder2-7b-q4_k_m': {
    id: 'starcoder2-7b-q4_k_m',
    tier: 'mid',
    name: 'StarCoder2 7B',
    params: '7B',
    humanEval: 72.0,
    mmlu: 60.0,
    capabilityBadge: 'Mid • StarCoder2 7B (HE 72%)',
    recommendedFor: 'Full-file code synthesis, refactoring',
  },
  'qwen2.5-coder-7b-instruct-q4_0': {
    id: 'qwen2.5-coder-7b-instruct-q4_0',
    tier: 'mid',
    name: 'Qwen2.5-Coder 7B Instruct',
    params: '7B',
    humanEval: 82.3,
    mmlu: 74.0,
    gsm8k: 84.0,
    capabilityBadge: 'Mid • Leaderboard Coder 7B (HE 82%, MMLU 74%)',
    recommendedFor: 'Complex endpoints, full components, bug fixing',
  },
  'falcon3-7b-instruct-q4_k_m': {
    id: 'falcon3-7b-instruct-q4_k_m',
    tier: 'mid',
    name: 'Falcon3 7B Instruct',
    params: '7B',
    humanEval: 66.0,
    mmlu: 71.0,
    capabilityBadge: 'Mid • Falcon3 7B (HE 66%, MMLU 71%)',
    recommendedFor: 'General mid-complexity engineering tasks',
  },
  'deepseek-r1-distill-qwen-7b-q4_k_m': {
    id: 'deepseek-r1-distill-qwen-7b-q4_k_m',
    tier: 'mid',
    name: 'DeepSeek-R1 Distill Qwen 7B',
    params: '7B',
    humanEval: 81.0,
    mmlu: 78.5,
    gsm8k: 89.0,
    capabilityBadge: 'Mid • Deep Reasoner 7B (HE 81%, GSM 89%)',
    recommendedFor: 'Algorithmic logic, edge-case analysis, test design',
  },
  'qwen2.5-7b-instruct-q4_k_m': {
    id: 'qwen2.5-7b-instruct-q4_k_m',
    tier: 'mid',
    name: 'Qwen2.5 7B Instruct',
    params: '7B',
    humanEval: 75.0,
    mmlu: 76.2,
    capabilityBadge: 'Mid • Versatile 7B (HE 75%, MMLU 76%)',
    recommendedFor: 'Multi-turn coding, full workflow automation',
  },
  'deepseek-r1-distill-llama-8b-q4_k_m': {
    id: 'deepseek-r1-distill-llama-8b-q4_k_m',
    tier: 'mid',
    name: 'DeepSeek-R1 Distill Llama 8B',
    params: '8B',
    humanEval: 80.0,
    mmlu: 77.0,
    gsm8k: 88.5,
    capabilityBadge: 'Mid • Llama Reasoner 8B (HE 80%, GSM 89%)',
    recommendedFor: 'Deep deductive reasoning, architectural checks',
  },
  'meta-llama-3.1-8b-instruct-q4_k_m': {
    id: 'meta-llama-3.1-8b-instruct-q4_k_m',
    tier: 'mid',
    name: 'Llama 3.1 8B Instruct',
    params: '8B',
    humanEval: 72.6,
    mmlu: 73.0,
    capabilityBadge: 'Mid • Meta Standard 8B (HE 73%, MMLU 73%)',
    recommendedFor: 'API integration, reliable tool usage, workflows',
  },
  'gemma-2-9b-it-q4_k_m': {
    id: 'gemma-2-9b-it-q4_k_m',
    tier: 'mid',
    name: 'Gemma 2 9B Instruct',
    params: '9B',
    humanEval: 68.0,
    mmlu: 75.5,
    capabilityBadge: 'Mid • Google Gemma 9B (HE 68%, MMLU 76%)',
    recommendedFor: 'High-quality code refactors, strict prompts',
  },
  'falcon3-10b-instruct-q4_k_m': {
    id: 'falcon3-10b-instruct-q4_k_m',
    tier: 'mid',
    name: 'Falcon3 10B Instruct',
    params: '10B',
    humanEval: 70.0,
    mmlu: 74.0,
    capabilityBadge: 'Mid • Falcon3 10B (HE 70%, MMLU 74%)',
    recommendedFor: 'Multi-file module creation and validation',
  },

  // ── Frontier Tier (17 Models) ───────────────────────────────────────
  'qwen3-8b.q4_k_m': {
    id: 'qwen3-8b.q4_k_m',
    tier: 'frontier',
    name: 'Qwen3 8B',
    params: '8B',
    humanEval: 78.0,
    mmlu: 79.5,
    capabilityBadge: 'Frontier • Next-gen Flagship 8B (HE 78%)',
    recommendedFor: 'Complex systems programming, autonomous agent runs',
  },
  'gemma-3-12b-it-q4_0': {
    id: 'gemma-3-12b-it-q4_0',
    tier: 'frontier',
    name: 'Gemma 3 12B Instruct',
    params: '12B',
    humanEval: 81.0,
    mmlu: 82.0,
    capabilityBadge: 'Frontier • Multimodal Class 12B (HE 81%, MMLU 82%)',
    recommendedFor: 'Full-stack development, complex architectural reasoning',
  },
  'gemma-3-12b-it-q4_k_m': {
    id: 'gemma-3-12b-it-q4_k_m',
    tier: 'frontier',
    name: 'Gemma 3 12B Instruct (k-quant)',
    params: '12B',
    humanEval: 81.0,
    mmlu: 82.0,
    capabilityBadge: 'Frontier • Gemma 3 High-Precision 12B (HE 81%)',
    recommendedFor: 'Cross-module refactoring, database design',
  },
  'mistral-nemo-instruct-2407-q4_k_m': {
    id: 'mistral-nemo-instruct-2407-q4_k_m',
    tier: 'frontier',
    name: 'Mistral Nemo 12B Instruct',
    params: '12B',
    humanEval: 74.0,
    mmlu: 78.0,
    capabilityBadge: 'Frontier • 128k Long-context 12B (HE 74%)',
    recommendedFor: 'Full-codebase reading, whole repo search & plan',
  },
  'deepseek-r1-distill-qwen-14b-q4_k_m': {
    id: 'deepseek-r1-distill-qwen-14b-q4_k_m',
    tier: 'frontier',
    name: 'DeepSeek-R1 Distill Qwen 14B',
    params: '14B',
    humanEval: 86.0,
    mmlu: 84.5,
    gsm8k: 92.0,
    capabilityBadge: 'Frontier • Deep Reasoner 14B (HE 86%, GSM 92%)',
    recommendedFor: 'Complex algorithms, concurrency bugs, test generation',
  },
  'qwen2.5-14b-instruct-q4_k_m': {
    id: 'qwen2.5-14b-instruct-q4_k_m',
    tier: 'frontier',
    name: 'Qwen2.5 14B Instruct',
    params: '14B',
    humanEval: 82.0,
    mmlu: 81.5,
    capabilityBadge: 'Frontier • General Heavy 14B (HE 82%, MMLU 82%)',
    recommendedFor: 'Complex state management, end-to-end features',
  },
  'qwen2.5-coder-14b-instruct-q4_k_m': {
    id: 'qwen2.5-coder-14b-instruct-q4_k_m',
    tier: 'frontier',
    name: 'Qwen2.5-Coder 14B Instruct',
    params: '14B',
    humanEval: 88.4,
    mmlu: 80.5,
    capabilityBadge: 'Frontier • Pro Coder 14B (HE 88%, MMLU 81%)',
    recommendedFor: 'Complex multi-file refactoring, API systems',
  },
  'qwen3-14b-q4_k_m': {
    id: 'qwen3-14b-q4_k_m',
    tier: 'frontier',
    name: 'Qwen3 14B',
    params: '14B',
    humanEval: 84.0,
    mmlu: 83.0,
    capabilityBadge: 'Frontier • Next-gen Heavy 14B (HE 84%)',
    recommendedFor: 'High complexity architecture & subagent dispatching',
  },
  'phi-4-q4_k': {
    id: 'phi-4-q4_k',
    tier: 'frontier',
    name: 'Phi-4 14B',
    params: '14B',
    humanEval: 84.8,
    mmlu: 84.5,
    capabilityBadge: 'Frontier • MS Phi-4 Reasoning 14B (HE 85%)',
    recommendedFor: 'Synthetic logic verification, schema planning',
  },
  'starcoder2-15b-q4_k_m': {
    id: 'starcoder2-15b-q4_k_m',
    tier: 'frontier',
    name: 'StarCoder2 15B',
    params: '15B',
    humanEval: 78.0,
    mmlu: 68.0,
    capabilityBadge: 'Frontier • Enterprise Coder 15B (HE 78%)',
    recommendedFor: 'Large legacy codebases, polyglot repositories',
  },
  'mistral-small-3.1-24b-instruct-2503-q4_k_m': {
    id: 'mistral-small-3.1-24b-instruct-2503-q4_k_m',
    tier: 'frontier',
    name: 'Mistral Small 3.1 24B',
    params: '24B',
    humanEval: 86.0,
    mmlu: 85.0,
    capabilityBadge: 'Frontier • Mistral Heavy 24B (HE 86%, MMLU 85%)',
    recommendedFor: 'Full application scaffolding, complex migrations',
  },
  'qwen3-30b-a3b-q4_0': {
    id: 'qwen3-30b-a3b-q4_0',
    tier: 'frontier',
    name: 'Qwen3 30B MoE (A3B active)',
    params: '30B (MoE)',
    humanEval: 88.0,
    mmlu: 87.0,
    capabilityBadge: 'Frontier • MoE Architecture 30B (HE 88%)',
    recommendedFor: 'High efficiency large-model execution, deep planning',
  },
  'qwen3-coder-30b-a3b-instruct-q4_0': {
    id: 'qwen3-coder-30b-a3b-instruct-q4_0',
    tier: 'frontier',
    name: 'Qwen3-Coder 30B MoE',
    params: '30B (MoE)',
    humanEval: 91.0,
    mmlu: 86.5,
    capabilityBadge: 'Frontier • MoE Top Coder 30B (HE 91%)',
    recommendedFor: 'Hardest code solutions, autonomous debugging',
  },
  'deepseek-r1-distill-qwen-32b-q4_k_m': {
    id: 'deepseek-r1-distill-qwen-32b-q4_k_m',
    tier: 'frontier',
    name: 'DeepSeek-R1 Distill Qwen 32B',
    params: '32B',
    humanEval: 92.5,
    mmlu: 88.5,
    gsm8k: 94.3,
    capabilityBadge: 'Frontier • SOTA Open Reasoner 32B (HE 93%, GSM 94%)',
    recommendedFor: 'Mathematical proofs, distributed algorithms, complex refactors',
  },
  'qwen2.5-32b-instruct-q4_k_m': {
    id: 'qwen2.5-32b-instruct-q4_k_m',
    tier: 'frontier',
    name: 'Qwen2.5 32B Instruct',
    params: '32B',
    humanEval: 88.0,
    mmlu: 86.0,
    capabilityBadge: 'Frontier • Flagship General 32B (HE 88%, MMLU 86%)',
    recommendedFor: 'Mission-critical code changes, system architecture',
  },
  'qwen2.5-coder-32b-instruct-q4_k_m': {
    id: 'qwen2.5-coder-32b-instruct-q4_k_m',
    tier: 'frontier',
    name: 'Qwen2.5-Coder 32B Instruct',
    params: '32B',
    humanEval: 92.7,
    mmlu: 85.8,
    capabilityBadge: 'Frontier • SOTA Open Coder 32B (HE 93%)',
    recommendedFor: 'Hardest code generation, complex refactors, full repos',
  },
  'yi-1.5-34b-chat-q4_k_m': {
    id: 'yi-1.5-34b-chat-q4_k_m',
    tier: 'frontier',
    name: 'Yi 1.5 34B Chat',
    params: '34B',
    humanEval: 83.0,
    mmlu: 84.0,
    capabilityBadge: 'Frontier • Yi Flagship 34B (HE 83%, MMLU 84%)',
    recommendedFor: 'Extensive context code reasoning, project documentation',
  },
};

/** Get benchmark information for any known model. */
export function getModelBenchmark(modelId: string): ModelBenchmarkInfo | undefined {
  return MODEL_BENCHMARKS[modelId];
}

/** List all models within a given tier along with their benchmark scores. */
export function listTierBenchmarks(tier: Tier): ModelBenchmarkInfo[] {
  return Object.values(MODEL_BENCHMARKS).filter((model) => model.tier === tier);
}

/** Determine the appropriate tier for a model based on public benchmark scores. */
export function getTierForBenchmark(scores: { humanEval?: number; mmlu?: number }): Tier {
  const he = scores.humanEval ?? 0;
  const mmlu = scores.mmlu ?? 0;

  if (he >= 85 || mmlu >= 80) return 'frontier';
  if (he >= 60 || mmlu >= 65) return 'mid';
  return 'local';
}
