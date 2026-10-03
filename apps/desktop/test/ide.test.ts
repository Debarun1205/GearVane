import { describe, expect, it } from 'vitest';

import { languageForPath } from '../src/ide/languages.js';
import { buildTree, flatten } from '../src/ide/file-tree.js';

/**
 * IDE unit tests.
 *
 * Only the parts that run without a browser are tested here: the language
 * mapping, the tree builder, and the tree flattener. The editor setup pulls
 * in the whole Monaco AMD build, and the tree renderer and IDE view need a
 * DOM, so those are covered by source-level guards in desktop.test.ts rather
 * than executed.
 */

describe('languageForPath', () => {
  it.each([
    ['index.ts', 'typescript'],
    ['app.tsx', 'typescript'],
    ['main.js', 'javascript'],
    ['lib.mjs', 'javascript'],
    ['legacy.cjs', 'javascript'],
    ['view.jsx', 'javascript'],
    ['data.json', 'json'],
    ['page.html', 'html'],
    ['page.htm', 'html'],
    ['feed.xml', 'xml'],
    ['icon.svg', 'xml'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['doc.md', 'markdown'],
    ['style.css', 'css'],
    ['script.py', 'python'],
    ['query.sql', 'sql'],
    ['run.sh', 'shell'],
    ['main.rs', 'rust'],
    ['main.go', 'go'],
    ['notes.txt', 'plaintext'],
  ])('maps %s to %s', (path, expected) => {
    expect(languageForPath(path)).toBe(expected);
  });

  it('ignores case', () => {
    expect(languageForPath('README.MD')).toBe('markdown');
    expect(languageForPath('App.TSX')).toBe('typescript');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(languageForPath('archive.zip')).toBe('plaintext');
    expect(languageForPath('binary.exe')).toBe('plaintext');
  });

  it('falls back to plaintext with no extension', () => {
    expect(languageForPath('Makefile')).toBe('plaintext');
    expect(languageForPath('LICENSE')).toBe('plaintext');
  });

  it('falls back to plaintext for dotfiles', () => {
    expect(languageForPath('.gitignore')).toBe('plaintext');
  });

  it('uses the last extension only', () => {
    // archive.tar.gz has no mapping for gz, so it is plaintext rather than
    // guessing from an inner extension.
    expect(languageForPath('archive.tar.gz')).toBe('plaintext');
  });
});

describe('buildTree', () => {
  it('returns an empty list for an empty workspace', () => {
    expect(buildTree([], '/project')).toEqual([]);
  });

  it('sorts directories before files', () => {
    const nodes = buildTree(
      [
        { name: 'zebra.ts', path: 'zebra.ts', isDirectory: false },
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'apple.ts', path: 'apple.ts', isDirectory: false },
      ],
      '/project',
    );

    expect(nodes.map((node) => node.name)).toEqual(['src', 'apple.ts', 'zebra.ts']);
  });

  it('nests children under their directory', () => {
    const nodes = buildTree(
      [
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'index.ts', path: 'src/index.ts', isDirectory: false },
      ],
      '/project',
    );

    expect(nodes).toHaveLength(1);
    const dir = nodes[0];
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.children.map((child) => child.name)).toEqual(['index.ts']);
  });

  it('creates missing intermediate directories', () => {
    // A partial listing may mention a file whose directory was never listed.
    // Every created level must be attached: an earlier version built a node
    // without attaching it, so the tree silently rendered nothing.
    const nodes = buildTree(
      [{ name: 'deep.ts', path: 'a/b/deep.ts', isDirectory: false }],
      '/project',
    );

    expect(nodes).toHaveLength(1);
    const top = nodes[0];
    expect(top?.name).toBe('a');
    expect(top?.isDirectory).toBe(true);
    const names = top ? flatten(top).map((node) => node.name) : [];
    expect(names).toEqual(['a', 'b', 'deep.ts']);
  });

  it('handles absolute paths under the root', () => {
    const nodes = buildTree(
      [
        { name: 'src', path: '/project/src', isDirectory: true },
        { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false },
      ],
      '/project',
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.children).toHaveLength(1);
  });

  it('normalises backslash separators', () => {
    const nodes = buildTree(
      [{ name: 'index.ts', path: 'src\\index.ts', isDirectory: false }],
      'C:\\project',
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe('src');
  });

  it('does not mutate the input', () => {
    const entries = [
      { name: 'b.ts', path: 'b.ts', isDirectory: false },
      { name: 'a.ts', path: 'a.ts', isDirectory: false },
    ];
    buildTree(entries, '/project');
    expect(entries.map((entry) => entry.name)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('flatten', () => {
  it('walks depth-first', () => {
    const nodes = buildTree(
      [
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'index.ts', path: 'src/index.ts', isDirectory: false },
        { name: 'top.ts', path: 'top.ts', isDirectory: false },
      ],
      '/project',
    );

    // src comes first (directories sort first), then its child, then top.ts.
    const root = {
      name: 'project',
      path: '/project',
      isDirectory: true,
      children: nodes,
    };
    expect(flatten(root).map((node) => node.name).join(',')).toBe(
      'project,src,index.ts,top.ts',
    );
  });
});
