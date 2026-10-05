/**
 * Skills: the agent capabilities the app ships.
 *
 * A static list on purpose: the renderer bundle also ships inside the
 * Android webview, where a value import of the harness tool modules would
 * drag Node-only code into the browser. The names below mirror the tool
 * definitions in packages/harness/src/tools (see the parity test), and
 * any new harness tool must be added here to appear in the sidebar.
 */

export interface Skill {
  /** Tool name the agent loop calls. */
  name: string;
  /** One line for the sidebar row. */
  blurb: string;
  /** Harness source that defines it, so drift has a pointer. */
  source: string;
}

export const SKILLS: Skill[] = [
  { name: 'read_file', blurb: 'Read workspace files', source: 'tools/fs.ts' },
  { name: 'write_file', blurb: 'Create or overwrite files', source: 'tools/fs.ts' },
  { name: 'edit_file', blurb: 'Patch files by match', source: 'tools/fs.ts' },
  { name: 'list_dir', blurb: 'List directories', source: 'tools/fs.ts' },
  { name: 'mkdir', blurb: 'Create directories', source: 'tools/fs.ts' },
  { name: 'search_files', blurb: 'Search file contents', source: 'tools/search.ts' },
  { name: 'run_command', blurb: 'Run shell commands', source: 'tools/shell.ts' },
  { name: 'list_templates', blurb: 'List site templates', source: 'builder/agent-tools.ts' },
  { name: 'scaffold_project', blurb: 'Scaffold a project', source: 'builder/agent-tools.ts' },
];
