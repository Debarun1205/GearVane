import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

export interface SkillManifest {
  name: string;
  description: string;
  instructions: string;
  location: string;
}

export interface ScheduledTask {
  id: string;
  cronOrDuration: string;
  prompt: string;
  createdAt: number;
}

const scheduledTasks = new Map<string, ScheduledTask>();

/** Discover and read local SKILL.md bundles in a workspace or global dir */
export function discoverSkills(workspaceRoot: string): SkillManifest[] {
  const skills: SkillManifest[] = [];
  const searchDirs = [
    join(workspaceRoot, '.gearvane', 'skills'),
    join(workspaceRoot, '.skills'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(dir, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          const raw = readFileSync(skillFile, 'utf8');
          // Parse simple frontmatter if present
          let name = entry.name;
          let description = `Custom skill: ${entry.name}`;
          const lines = raw.split(/\r?\n/);
          for (const line of lines.slice(0, 10)) {
            if (line.startsWith('name:')) name = line.replace('name:', '').trim();
            if (line.startsWith('description:')) description = line.replace('description:', '').trim();
          }
          skills.push({
            name,
            description,
            instructions: raw,
            location: skillFile,
          });
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  return skills;
}

/** Tool to discover and read custom skill instructions */
export const loadSkillTool: Tool = {
  schema: {
    name: 'load_skill',
    description: 'Inspect and load specialized skill instructions from .gearvane/skills or .skills directory.',
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Name of the skill to load, or leave empty to list all available custom skills.',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const skills = discoverSkills(ctx.workspace.root);
    const wanted = String(args['skillName'] ?? '').trim().toLowerCase();

    if (!wanted) {
      if (skills.length === 0) {
        return {
          ok: true,
          content: 'No custom SKILL.md skills found in .gearvane/skills or .skills directory.',
        };
      }
      const list = skills.map((s) => `• ${s.name}: ${s.description} (${s.location})`).join('\n');
      return {
        ok: true,
        content: `Available custom skills:\n${list}`,
      };
    }

    const found = skills.find((s) => s.name.toLowerCase() === wanted);
    if (!found) {
      return failure(`Skill "${wanted}" not found.`);
    }

    return {
      ok: true,
      content: `Loaded skill "${found.name}":\n\n${found.instructions}`,
    };
  },
};

/** Tool to schedule recurring background agent tasks (cron / timers) */
export const scheduleTaskTool: Tool = {
  schema: {
    name: 'schedule_task',
    description: 'Schedule a prompt or instruction on a timer (seconds) or cron expression.',
    parameters: {
      type: 'object',
      properties: {
        schedule: {
          type: 'string',
          description: 'Duration in seconds (e.g. "60") or 5-field cron expression (e.g. "0 9 * * *").',
        },
        prompt: {
          type: 'string',
          description: 'Task instructions to execute when triggered.',
        },
      },
      required: ['schedule', 'prompt'],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const schedule = String(args['schedule'] ?? '').trim();
    const prompt = String(args['prompt'] ?? '').trim();

    if (!schedule) return failure('Schedule duration or cron expression is required.');
    if (!prompt) return failure('Prompt is required.');

    const id = `task-${Date.now().toString(36)}`;
    scheduledTasks.set(id, { id, cronOrDuration: schedule, prompt, createdAt: Date.now() });

    return {
      ok: true,
      content: `Scheduled task ${id} registered successfully.\nTrigger: "${schedule}"\nAction: "${prompt}"`,
    };
  },
};
