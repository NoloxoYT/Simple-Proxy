// Proxy HTTP/HTTPS universel compatible Codespaces
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const net = require('net');

let logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.push(line);
  if (logs.length > 100) logs = logs.slice(-100);
  console.log(line);
}

const PORT = process.env.PORT || process.env.PROXY_PORT || 8080;
const TARGET = process.env.PROXY_TARGET || 'http://localhost:3000';
const USE_HTTPS = process.env.PROXY_HTTPS === '1' || process.env.PROXY_HTTPS === 'true';

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  ws: true,
  changeOrigin: true,
  secure: false, // Pour Codespaces, on désactive la vérification SSL
});

proxy.on('error', (err, req, res) => {
  log('Proxy error: ' + err);
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
  }
  res.end('Proxy error: ' + err.message);
});

const dashboardHTML = () => `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Proxy Dashboard</title>
  <style>
    body { font-family: sans-serif; background: #f7f7f7; margin: 0; padding: 2em; }
    .container { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #0001; max-width: 500px; margin: auto; padding: 2em; }
    h1 { color: #2d72d9; }
    label { display: block; margin-top: 1em; }
    input[type=text] { width: 100%; padding: 0.5em; margin-top: 0.5em; }
    button { margin-top: 1em; padding: 0.5em 1.5em; background: #2d72d9; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    .info { margin-top: 2em; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Proxy Dashboard</h1>
    <form method="POST" action="/set-target">
      <label for="target">Cible actuelle :</label>
      <input type="text" id="target" name="target" value="${TARGET}" required />
      <button type="submit">Changer la cible</button>
    </form>
    <div class="info">
      <p><b>Port d'écoute :</b> ${PORT}</p>
      <p><b>HTTPS :</b> ${USE_HTTPS ? 'Oui' : 'Non'}</p>
    </div>
  </div>
</body>
</html>
`;

function serveStatic(req, res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

const isDashboardOrApi = (pathname) => {
  return (
    pathname.startsWith('/public/') ||
    pathname === '/' ||
    pathname === '/dashboard' ||
    pathname.startsWith('/api/')
  );
};

const requestHandler = (req, res) => {
  const parsedUrl = url.parse(req.url);
  if (isDashboardOrApi(parsedUrl.pathname)) {
    // Static files
    if (parsedUrl.pathname.startsWith('/public/')) {
      const ext = path.extname(parsedUrl.pathname);
      const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/plain';
      return serveStatic(req, res, path.join(__dirname, parsedUrl.pathname), contentType);
    }
    // Dashboard
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/dashboard') {
      return serveStatic(req, res, path.join(__dirname, 'public/index.html'), 'text/html');
    }
    // API: config GET
    if (parsedUrl.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ target: TARGET, port: PORT, https: USE_HTTPS }));
      return;
    }
    // API: config POST
    if (parsedUrl.pathname === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.target) TARGET = data.target;
          if (data.port) PORT = data.port;
          if (typeof data.https === 'boolean') USE_HTTPS = data.https;
          proxy.options.target = TARGET;
          log(`Config changée: target=${TARGET}, port=${PORT}, https=${USE_HTTPS}`);
          res.writeHead(200); res.end('Configuration mise à jour (le port/https nécessite un redémarrage manuel)');
        } catch (e) {
          res.writeHead(400); res.end('Erreur de parsing');
        }
      });
      return;
    }
    // API: logs
    if (parsedUrl.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(logs.join('\n'));
      return;
    }
    // API: test connectivité
    if (parsedUrl.pathname === '/api/test') {
      const testUrl = TARGET;
      const testReq = (testUrl.startsWith('https') ? https : http).get(testUrl, (r) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: r.statusCode }));
      });
      testReq.on('error', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      });
      return;
    }
  }
  // FORWARD PROXY LOGIC
  // Si la requête a une URL absolue (proxy HTTP)
  if (/^http:\/\//.test(req.url) || /^https:\/\//.test(req.url)) {
    const targetUrl = req.url;
    log(`HTTP proxy: ${req.method} ${targetUrl}`);
    proxy.web(req, res, { target: targetUrl, changeOrigin: true, secure: false });
    return;
  }
  // Sinon, requête relative (peut arriver pour certains clients)
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Bad request: use as HTTP/HTTPS proxy');
};

let server;
if (USE_HTTPS) {
  // Pour HTTPS, il faut fournir des certificats (ici, auto-générés ou à configurer)
  const cert = process.env.PROXY_CERT || path.join(__dirname, 'cert.pem');
  const key = process.env.PROXY_KEY || path.join(__dirname, 'key.pem');
  server = https.createServer({
    cert: fs.readFileSync(cert),
    key: fs.readFileSync(key),
  }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

// Support WebSocket (pour HTTP proxy)
server.on('upgrade', (req, socket, head) => {
  if (/^http:\/\//.test(req.url) || /^https:\/\//.test(req.url)) {
    log(`WS proxy: ${req.url}`);
    proxy.ws(req, socket, head, { target: req.url, changeOrigin: true, secure: false });
  } else {
    // Dashboard/API: pas de WS
    socket.destroy();
  }
});

// Support HTTPS CONNECT
server.on('connect', (req, clientSocket, head) => {
  // Ex: req.url = 'example.com:443'
  const [host, port] = req.url.split(':');
  log(`CONNECT proxy: ${req.url}`);
  const serverSocket = net.connect(port || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on('error', (err) => {
    log(`CONNECT error: ${err}`);
    clientSocket.end();
  });
});

server.listen(PORT, () => {
  log(`Proxy listening on port ${PORT}, forwarding to ${TARGET}`);
}); 