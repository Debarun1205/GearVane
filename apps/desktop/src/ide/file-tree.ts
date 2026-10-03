/**
 * File tree for the IDE.
 *
 * Reads through the same `Workspace` containment as every other tool, so the
 * tree cannot be tricked into listing outside the project, and a file the
 * agent writes is visible in the tree without a manual refresh.
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

/** A node in the rendered tree. */
export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

/**
 * Build a tree from a flat listing.
 *
 * Sorted directories-first so the order is stable between renders; a tree that
 * reshuffles itself makes the user lose their place.
 */
export function buildTree(entries: FileEntry[], root: string): TreeNode[] {
  const directories = new Map<string, TreeNode>();
  const rootNode: TreeNode = {
    name: root.split(/[\\/]/).pop() ?? root,
    path: root,
    isDirectory: true,
    children: [],
  };
  // Keyed by the normalised path so lookups agree regardless of which
  // separator an entry arrived with.
  directories.set(normalise(root), rootNode);

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const entryPath = normalise(entry.path);
    const parent = parentOf(entryPath, directories, rootNode);
    const node: TreeNode = {
      name: entry.name,
      path: entryPath,
      isDirectory: entry.isDirectory,
      children: [],
    };
    parent.children.push(node);
    if (entry.isDirectory) directories.set(entryPath, node);
  }

  return rootNode.children;
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/');
}

function parentOf(
  path: string,
  directories: Map<string, TreeNode>,
  rootNode: TreeNode,
): TreeNode {
  const parentPath = path.split('/').slice(0, -1).join('/');
  if (parentPath === '') return rootNode;
  return ensureDir(parentPath, directories, rootNode);
}

/**
 * Find a directory node, creating it and any missing ancestors.
 *
 * Created nodes are attached to their parent as they are made. An earlier
 * version created a single node without attaching it, so every relative path
 * silently vanished: the function returns rootNode.children, which stayed
 * empty, and the tree rendered nothing.
 */
function ensureDir(
  dirPath: string,
  directories: Map<string, TreeNode>,
  rootNode: TreeNode,
): TreeNode {
  const hit = directories.get(dirPath);
  if (hit) return hit;

  const grandparentPath = dirPath.split('/').slice(0, -1).join('/');
  const parent =
    grandparentPath === '' ? rootNode : ensureDir(grandparentPath, directories, rootNode);

  const node: TreeNode = {
    name: dirPath.split('/').pop() ?? dirPath,
    path: dirPath,
    isDirectory: true,
    children: [],
  };
  parent.children.push(node);
  directories.set(dirPath, node);
  return node;
}

/** Flatten a tree for keyboard navigation. */
export function flatten(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  const walk = (current: TreeNode): void => {
    result.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return result;
}

/** Render a tree into a container, depth-first. */
export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  onOpen: (path: string) => void,
  depth = 0,
): void {
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'ide-tree-row';
    row.style.paddingLeft = `${depth * 0.75 + 0.5}rem`;
    // textContent, never innerHTML: file names come from the filesystem and can
    // contain anything.
    row.textContent = `${node.isDirectory ? '▸ ' : '  '}${node.name}`;
    row.dataset.path = node.path;

    if (node.isDirectory) {
      row.addEventListener('click', () => {
        const wasOpen = row.classList.contains('open');
        row.classList.toggle('open');
        const childContainer = row.nextElementSibling as HTMLElement | null;
        if (childContainer) childContainer.style.display = wasOpen ? 'none' : '';
      });
    } else {
      row.addEventListener('click', () => onOpen(node.path));
    }

    container.append(row);

    if (node.isDirectory && node.children.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'ide-tree-children';
      renderTree(childContainer, node.children, onOpen, depth + 1);
      container.append(childContainer);
    }
  }
}

