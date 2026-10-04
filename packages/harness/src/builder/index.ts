/**
 * The GearVane app builder.
 *
 * A **template engine with parameters**, plus the two agent tools that let a
 * model drive it from a prompt. The engine is shared by the CLI, the VS Code
 * panel, and the desktop app and IDE, so all of them produce identical output.
 *
 * Prompt-driven building lives only where a model can be reached: the agent
 * surfaces call `list_templates` and `scaffold_project` through the normal
 * tool loop. The marketing website has no builder at all, because prompting
 * needs a model call and a static page has no backend to make one from and no
 * safe place to keep a credential.
 *
 * Nothing in this package has published to a real host. The deploy interface
 * and the local writer are tested; the hosted targets are declared and refuse,
 * and `tests/builder-deploy.test.ts` asserts they keep refusing.
 *
 * The honest summary, restated because it is the part most likely to be
 * misread: there is **no** working hosted deploy here. `LocalDeployer` writes
 * to a folder on your own machine, which is complete and tested. The
 * Cloudflare, Netlify, and Vercel targets exist so the shape of one is written
 * down and the UI can explain what it would need. None of them uploads
 * anything, and a build that appears to have published a site would be a
 * serious defect rather than a success.
 */

export {
  TEMPLATES,
  NoFilesystemError,
  applyDefaults,
  escapeHtml,
  escapeJs,
  escapeRegex,
  getFileSystem,
  getTemplate,
  isValidSlug,
  materialise,
  plan,
  scaffold,
  setFileSystem,
  slugify,
  type FileSystemBridge,
  type ScaffoldFile,
  type ScaffoldOptions,
  type ScaffoldResult,
  type Template,
  type TemplateParam,
} from './scaffold.js';

export {
  createZip,
  renderPreview,
  toBase64,
} from './bundle.js';

export {
  builderTools,
  listTemplatesTool,
  scaffoldProjectTool,
} from './agent-tools.js';

export {
  FakeDeployer,
  LocalDeployer,
  UnconfiguredDeployer,
  defaultDeployers,
  type DeployFile,
  type DeployRequest,
  type DeployResult,
  type Deployer,
} from './deploy.js';