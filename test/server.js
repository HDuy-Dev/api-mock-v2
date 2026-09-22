const http = require('node:http');

const STARTUP_RACE_HTML = `<!doctype html>
<html><head><title>startup race</title>
<script>
  // Runs before any other page script; must already be answered by the mock.
  window.__early = fetch('/mocked-early').then((r) => r.text()).catch((e) => 'ERR ' + e);
</script></head><body>ok</body></html>`;

function send(res, status, headers, body) {
  const nullBody = status === 204 || status === 205 || status === 304;
  res.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  res.end(nullBody ? undefined : body);
}

function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    if (url.pathname === '/') {
      return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>test</title><body>ok</body>');
    }
    if (url.pathname === '/startup-race.html') {
      return send(res, 200, { 'content-type': 'text/html' }, STARTUP_RACE_HTML);
    }
    if (url.pathname === '/frame-parent.html') {
      return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>parent</title><iframe src="/"></iframe>');
    }
    if (url.pathname === '/reflect') {
      // Returns exactly what the query asks for: ?status=418&h=x-a:1&h=content-type:text/plain&body=hi
      const status = Number(url.searchParams.get('status') || 200);
      const headers = {};
      for (const h of url.searchParams.getAll('h')) {
        const i = h.indexOf(':');
        headers[h.slice(0, i)] = h.slice(i + 1);
      }
      return send(res, status, headers, url.searchParams.get('body') ?? '');
    }
    return send(
      res,
      200,
      { 'content-type': 'application/json', 'x-source': 'server' },
      JSON.stringify({ source: 'server', method: req.method, path: url.pathname, query: url.search }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

module.exports = { startServer };
