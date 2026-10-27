import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    // Serve only the prototype, its image and the two Three.js ESM bundles.
    const allowed = ['index.html', 'style.css', 'app.js', 'tree.js', 'assets/mountain.jpg', 'node_modules/three/build/three.module.js', 'node_modules/three/build/three.core.js'];
    if (!allowed.includes(relative)) { res.writeHead(404).end('Not found'); return; }
    const bytes = await readFile(path.join(root, relative));
    res.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(Number(process.env.PORT || 4177), '0.0.0.0', () => console.log('Michi touch prototype → http://localhost:' + (process.env.PORT || 4177)));
