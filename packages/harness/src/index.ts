/**
 * @waypoint/harness
 *
 * The agent layer that sits on top of @waypoint/core's routing engine.
 *
 * Status: partial. Workspace containment and the file tool layer are built.
 * The agent loop, command containment, context management, and sessions are
 * not, and docs/harness-architecture.md is the source of truth for that.
 */

export {
  ContainmentError,
  InvalidPathError,
  Workspace,
  isInside,
  type RealpathLike,
  type WorkspaceOptions,
} from './workspace/containment.js';

export {
  ToolArgumentError,
  failure,
  validateArgs,
  type JsonSchema,
  type JsonSchemaProperty,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from './tools/types.js';

export { ToolRegistry } from './tools/registry.js';

export {
  DEFAULT_MAX_READ_BYTES,
  editFileTool,
  fileTools,
  listDirTool,
  mkdirTool,
  readFileTool,
  writeFileTool,
} from './tools/fs.js';