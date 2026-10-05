/**
 * Thinking effort: how much work a run may do.
 *
 * Eigent exposes Default / Low / Medium / High / Extra High / Max. Here the
 * knob drives two real budgets: maxTokens on chat completions and
 * maxIterations on the IDE agent loop (the host clamps iterations at 50).
 * Temperature is left alone so effort never changes answer style, only
 * how long the model may think.
 */

export interface Effort {
  id: string;
  label: string;
  hint: string;
  maxTokens: number;
  maxIterations: number;
}

export const EFFORTS: Effort[] = [
  { id: 'low', label: 'Low', hint: 'Quick answers, few steps', maxTokens: 512, maxIterations: 5 },
  { id: 'default', label: 'Default', hint: 'Balanced cost and depth', maxTokens: 2048, maxIterations: 10 },
  { id: 'medium', label: 'Medium', hint: 'Room for harder tasks', maxTokens: 4096, maxIterations: 15 },
  { id: 'high', label: 'High', hint: 'Deep reasoning, more steps', maxTokens: 8192, maxIterations: 25 },
  { id: 'extra', label: 'Extra High', hint: 'Long investigations', maxTokens: 16384, maxIterations: 35 },
  { id: 'max', label: 'Max', hint: 'Everything the host allows', maxTokens: 32768, maxIterations: 50 },
];

export const DEFAULT_EFFORT = 'default';

export function effortById(id: string): Effort {
  return EFFORTS.find((effort) => effort.id === id) ?? EFFORTS[1] as Effort;
}

export function maxTokensFor(id: string): number {
  return effortById(id).maxTokens;
}

export function maxIterationsFor(id: string): number {
  return effortById(id).maxIterations;
}
