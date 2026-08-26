import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Minimal static server for the fixtures, because Cypress needs an http origin —
 * `file://` URLs are not reliably visitable.
 */
export async function startStaticServer(root: string, port = 0): Promise<{ server: Server; url: string }> {
  const rootPath = resolve(root);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const target = resolve(join(rootPath, normalize(requested)));

        // Refuse anything that escapes the served directory.
        if (target !== rootPath && !target.startsWith(rootPath + sep)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        const info = await stat(target).catch(() => null);
        if (!info || info.isDirectory()) {
          res.writeHead(404).end('Not found');
          return;
        }

        const body = await readFile(target);
        res.writeHead(200, {
          'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(500).end('Server error');
      }
    })();
  });

  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  server.unref();

  return { server, url: `http://127.0.0.1:${actualPort}` };
}
