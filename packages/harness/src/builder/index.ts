/**
 * The Waypoint app builder.
 *
 * A **template engine with parameters**, shared by the website and the desktop
 * app so both produce identical output.
 *
 * The split between the two surfaces is not a preference; it follows from
 * where a credential can live:
 *
 * - The **website** can scaffold, preview, and download a zip. It cannot
 *   publish, because a deploy token in browser JavaScript is a token handed to
 *   every visitor, and GitHub Pages has no backend to keep it out of.
 * - The **desktop app** can additionally publish, because it has a filesystem
 *   and a main process where a token can stay out of the renderer.
 *
 * Nothing in this package has published to a real host. The deploy interface
 * and the local writer are tested; the hosted targets are declared and refuse,
 * and `tests/builder-deploy.test.ts` asserts they keep refusing.
 */

export {
  TEMPLATES,
  applyDefaults,
  escapeHtml,
  escapeJs,
  escapeRegex,
  getTemplate,
  isValidSlug,
  materialise,
  plan,
  scaffold,
  slugify,
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
  FakeDeployer,
  LocalDeployer,
  UnconfiguredDeployer,
  defaultDeployers,
  type DeployFile,
  type DeployRequest,
  type DeployResult,
  type Deployer,
} from './deploy.js';