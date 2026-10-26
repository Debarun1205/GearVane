import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  options: QuestionOption[];
  allowMultiple?: boolean;
}

/** Handler function supplied by the UI or host to display question dialogs */
export type QuestionHandler = (prompt: QuestionPrompt) => Promise<string | string[]>;

let activeQuestionHandler: QuestionHandler | undefined;

/** Register the interactive question handler (wired from Electron main/renderer or CLI) */
export function setQuestionHandler(handler: QuestionHandler | undefined): void {
  activeQuestionHandler = handler;
}

/**
 * Interactive question tool for soliciting clarifications or preferences.
 */
export const askQuestionTool: Tool = {
  schema: {
    name: 'ask_question',
    description:
      'Ask the user a multiple-choice question to clarify requirements, solicit design preferences, ' +
      'or pick an architectural solution before executing destructive or ambiguous actions.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The specific question to ask the user.',
        },
        options: {
          type: 'array',
          description: 'List of answer choices for the user to select from.',
          items: {
            type: 'string',
            description: 'The choice label or text.',
          },
        },
        allowMultiple: {
          type: 'boolean',
          description: 'Whether the user can select more than one option (checkboxes vs radio buttons).',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
    if (!question) return failure('Question text cannot be empty.');

    const rawOptions = Array.isArray(args['options']) ? args['options'] : [];
    if (rawOptions.length < 2) {
      return failure('At least 2 options must be provided for a choice question.');
    }

    const options: QuestionOption[] = rawOptions.map((opt: any) => ({
      label: typeof opt === 'string' ? opt : String(opt?.label ?? ''),
      description: typeof opt === 'object' && opt?.description ? String(opt.description) : undefined,
    }));

    const allowMultiple = Boolean(args['allowMultiple']);

    if (!activeQuestionHandler) {
      // In non-interactive mode or headless runs, auto-select the first option gracefully
      return {
        ok: true,
        content: `Selected by default (headless): "${options[0]?.label}"`,
      };
    }

    try {
      const answer = await activeQuestionHandler({ question, options, allowMultiple });
      const selected = Array.isArray(answer) ? answer.join(', ') : answer;
      return {
        ok: true,
        content: `User selected: ${selected}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failure(`Failed to receive user response: ${msg}`);
    }
  },
};
