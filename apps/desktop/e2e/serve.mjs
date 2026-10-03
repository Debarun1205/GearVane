/**
 * Static file server for the Playwright smoke suite.
 *
 * Serves the built renderer directory exactly as a dumb host would, with two
 * deliberate choices:
 *
 * - No host bridge. `window.waypoint` is absent, so the page takes the plain
 *   browser path it takes inside the Android webview.
 * - `/waypoint.config.json` answers with `{}`, which `parseConfig` normalises
 *   to full defaults. The renderer probes for this file when there is no
 *   bridge; answering with a 404 would inject an environment artefact into
 *   the console-error assertions rather than test the renderer.
 *
 * Node built-ins only: nothing to install, same behaviour on every OS.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8940;
const root = fileURLToPath(new URL('../renderer/', import.meta.url));

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const emptyConfig = Buffer.from('{}\n');

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/waypoint.config.json') {
      response.writeHead(200, { 'content-type': types['.json'] });
      response.end(emptyConfig);
      return;
    }

    let relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (relative === '' || relative === '.') relative = 'index.html';

    const file = join(root, relative);
    // Path traversal guard: nothing outside the renderer directory.
    if (!file.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    const data = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${PORT}`);
});
