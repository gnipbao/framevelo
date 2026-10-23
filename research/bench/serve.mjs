import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
export function serve(root) {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      fs.readFile(p.endsWith('/') ? p + 'index.html' : p, (e, b) => { if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); res.end(b); });
    }).listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}
