/**
 * Language mapping for the editor.
 *
 * Kept in its own module with no Monaco import so it can be unit tested in
 * Node. The editor setup in monaco.ts pulls in the whole Monaco AMD build,
 * which needs a browser environment.
 */

/**
 * A Monaco language id for a file path.
 *
 * Monaco ships a large language registry. Rather than importing all of it,
 * which would dominate the bundle, this maps by extension and falls back to
 * plain text. Syntax highlighting still works for the common cases; the
 * expensive IntelliSense features need the full language contributions, which
 * is a deliberate trade against bundle size.
 */
export function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';

  const byExtension: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', css: 'css', html: 'html', htm: 'html',
    xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', py: 'python', sql: 'sql', sh: 'shell',
    bash: 'shell', zsh: 'shell', toml: 'ini', ini: 'ini',
    rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
    txt: 'plaintext',
  };

  return byExtension[extension] ?? 'plaintext';
}
