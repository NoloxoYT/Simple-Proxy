// Proxy HTTP/HTTPS universel compatible Codespaces
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

let logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.push(line);
  if (logs.length > 100) logs = logs.slice(-100);
  console.log(line);
}

let PORT = process.env.PORT || process.env.PROXY_PORT || 8080;
let TARGET = process.env.PROXY_TARGET || 'http://localhost:3000';
let USE_HTTPS = process.env.PROXY_HTTPS === '1' || process.env.PROXY_HTTPS === 'true';

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
        let data;
        try {
          // Essayer de parser en JSON
          data = JSON.parse(body);
        } catch (e) {
          // Fallback: parser en x-www-form-urlencoded
          data = querystring.parse(body);
        }
        if (data.target) TARGET = data.target;
        if (data.port) PORT = data.port;
        if (typeof data.https === 'boolean' || data.https === 'true' || data.https === 'false') {
          USE_HTTPS = (data.https === true || data.https === 'true');
        }
        proxy.options.target = TARGET;
        log(`Config changée: target=${TARGET}, port=${PORT}, https=${USE_HTTPS}`);
        res.writeHead(200); res.end('Configuration mise à jour (le port/https nécessite un redémarrage manuel)');
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
    // API: proxy GET
    if (parsedUrl.pathname === '/api/proxy') {
      const query = querystring.parse(parsedUrl.query);
      let targetUrl = query.url;
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Paramètre url manquant ou invalide');
        return;
      }
      // Corriger le double encodage
      try {
        while (decodeURIComponent(targetUrl) !== targetUrl) {
          targetUrl = decodeURIComponent(targetUrl);
        }
      } catch {}
      log(`Web proxy fetch: [${req.method}] ${targetUrl}`);
      const client = targetUrl.startsWith('https') ? https : http;
      // Forwarder tous les headers sauf 'host'
      const headers = { ...req.headers };
      delete headers['host'];
      // Logger les headers envoyés
      log('Headers envoyés: ' + JSON.stringify(headers));
      // Forwarder la méthode et le body
      const options = {
        method: req.method,
        headers,
      };
      let proxyReq;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        proxyReq = client.request(targetUrl, options, (proxyRes) => handleProxyResponse(proxyRes, res, targetUrl));
        req.pipe(proxyReq);
      } else {
        proxyReq = client.request(targetUrl, options, (proxyRes) => handleProxyResponse(proxyRes, res, targetUrl));
        req.pipe(proxyReq);
      }
      proxyReq.on('response', (proxyRes) => {
        if (proxyRes.statusCode === 400) {
          log(`Erreur 400 sur ${targetUrl} avec headers: ${JSON.stringify(headers)}`);
        }
      });
      proxyReq.on('error', (err) => {
        log(`Web proxy error: ${err}`);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Erreur lors de la récupération de la ressource');
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

function cleanUtm(url) {
  try {
    let u = new URL(url);
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_term');
    u.searchParams.delete('utm_content');
    return u.toString();
  } catch { return url; }
}

function handleProxyResponse(proxyRes, res, targetUrl) {
  let headers = { ...proxyRes.headers };
  // Réécrire les redirects pour qu'ils passent par le proxy et nettoyer les utm
  if (headers['location']) {
    let loc = headers['location'].startsWith('http') ? headers['location'] : (new URL(headers['location'], targetUrl)).href;
    loc = cleanUtm(loc);
    headers['location'] = `/api/proxy?url=${encodeURIComponent(loc)}`;
  }
  // Ajouter CORS sur tout
  headers['access-control-allow-origin'] = '*';
  // Forcer Referer et Origin à pointer vers le site cible
  headers['referer'] = targetUrl;
  headers['origin'] = (new URL(targetUrl)).origin;
  // Gérer le HTML
  const contentType = headers['content-type'] || '';
  const encoding = headers['content-encoding'] || '';
  // Si c'est une police (woff, woff2, ttf, otf, font/...)
  if (/font|woff|woff2|ttf|otf/i.test(contentType) || /\.(woff2?|ttf|otf)(\?|$)/i.test(targetUrl)) {
    log('Réponse font : ' + targetUrl + ' headers=' + JSON.stringify(headers));
    headers['access-control-allow-origin'] = '*';
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
    return;
  }
  if (contentType.includes('text/html')) {
    let chunks = [];
    proxyRes.on('data', chunk => { chunks.push(chunk); });
    proxyRes.on('end', () => {
      let buffer = Buffer.concat(chunks);
      const decompress = (buf, cb) => {
        if (encoding === 'gzip') zlib.gunzip(buf, cb);
        else if (encoding === 'br') zlib.brotliDecompress(buf, cb);
        else if (encoding === 'deflate') zlib.inflate(buf, cb);
        else cb(null, buf);
      };
      decompress(buffer, (err, rawHtml) => {
        if (err) {
          res.writeHead(502, headers);
          res.end('Erreur de décompression');
          return;
        }
        const baseUrl = targetUrl.replace(/\/[^/]*$/, '/');
        const alreadyProxied = url => url.startsWith('/api/proxy?url=');
        const safeEncode = url => {
          try {
            return encodeURIComponent(decodeURIComponent(url));
          } catch { return encodeURIComponent(url); }
        };
        const proxify = (url) => {
          if (!url) return url;
          if (alreadyProxied(url)) return url;
          if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('blob:')) return url;
          if (url.startsWith('//')) return `/api/proxy?url=${safeEncode(cleanUtm('https:' + url))}`;
          if (url.startsWith('http://') || url.startsWith('https://')) return `/api/proxy?url=${safeEncode(cleanUtm(url))}`;
          let abs = url.startsWith('/') ? (new URL(targetUrl)).origin + url : baseUrl + url;
          return `/api/proxy?url=${safeEncode(cleanUtm(abs))}`;
        };
        let html = rawHtml.toString('utf8');
        html = html.replace(/(href|src|action|formaction|poster)=(['"])(.*?)\2/gi, (m, attr, quote, link) => {
          return `${attr}=${quote}${proxify(link)}${quote}`;
        });
        html = html.replace(/srcset=(['"])(.*?)\1/gi, (m, quote, set) => {
          const proxified = set.split(',').map(part => {
            const [url, size] = part.trim().split(' ');
            return `${proxify(url)}${size ? ' ' + size : ''}`;
          }).join(', ');
          return `srcset=${quote}${proxified}${quote}`;
        });
        html = html.replace(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"'>]+)["']/gi, (m, url) => {
          return m.replace(url, proxify(url));
        });
        html = html.replace(/(window\.location(?:\.href)?\s*=\s*['"])([^'"]+)(['"])/gi, (m, pre, link, post) => {
          return `${pre}${proxify(link)}${post}`;
        });
        html = html.replace(/(fetch\(['"])([^'"]+)(['"])/gi, (m, pre, link, post) => {
          return `${pre}${proxify(link)}${post}`;
        });
        html = html.replace(/(open\(['"])([^'"]+)(['"])/gi, (m, pre, link, post) => {
          return `${pre}${proxify(link)}${post}`;
        });
        // Injection JS renforcée
        html = html.replace('</head>', `<script>(function(){
// Intercepte tous les liens cliqués
  document.addEventListener('click',function(e){
    let t=e.target.closest('a');
    if(t&&t.href&&!t.href.startsWith('/api/proxy?url=')){
      e.preventDefault();
      window.location='/api/proxy?url='+encodeURIComponent(t.href);
    }
  });
// Intercepte window.open
  const origOpen=window.open;window.open=function(u,...a){if(u&&!u.startsWith('/api/proxy?url=')){return origOpen('/api/proxy?url='+encodeURIComponent(u),...a);}return origOpen(u,...a);};
// Intercepte fetch
  const origFetch=window.fetch;window.fetch=function(u,...a){if(typeof u==='string'&&!u.startsWith('/api/proxy?url=')){return origFetch('/api/proxy?url='+encodeURIComponent(u),...a);}return origFetch(u,...a);};
// Intercepte XHR
  const origXHR=window.XMLHttpRequest;window.XMLHttpRequest=function(){const x=new origXHR();const origOpen=x.open;x.open=function(m,u,...a){if(typeof u==='string'&&!u.startsWith('/api/proxy?url=')){return origOpen.call(x,m,'/api/proxy?url='+encodeURIComponent(u),...a);}return origOpen.call(x,m,u,...a);};return x;};
// Intercepte pushState/replaceState
  const origPush=history.pushState;history.pushState=function(s,t,u){if(typeof u==='string'&&!u.startsWith('/api/proxy?url=')){return origPush.call(history,s,t,'/api/proxy?url='+encodeURIComponent(u));}return origPush.call(history,s,t,u);};
  const origReplace=history.replaceState;history.replaceState=function(s,t,u){if(typeof u==='string'&&!u.startsWith('/api/proxy?url=')){return origReplace.call(history,s,t,'/api/proxy?url='+encodeURIComponent(u));}return origReplace.call(history,s,t,u);};
// Bloque l'enregistrement des Service Workers
  if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.reject('Proxy: ServiceWorker disabled');};}
// MutationObserver pour réécrire les nouveaux liens/iframes dynamiquement
  const proxifyAttr=(el,attr)=>{if(el&&el[attr]&&!el[attr].startsWith('/api/proxy?url=')&&!el[attr].startsWith('data:')&&!el[attr].startsWith('javascript:'))el[attr]='/api/proxy?url='+encodeURIComponent(el[attr]);};
  const mo=new MutationObserver(ms=>{ms.forEach(m=>{m.addedNodes&&m.addedNodes.forEach(n=>{if(n.nodeType===1){['href','src','action','formaction','poster'].forEach(attr=>proxifyAttr(n,attr));if(n.tagName==='IFRAME'){proxifyAttr(n,'src');}}});});});
  mo.observe(document.documentElement,{childList:true,subtree:true});
})();</script></head>`);
        delete headers['content-encoding'];
        headers['content-length'] = Buffer.byteLength(html);
        res.writeHead(proxyRes.statusCode, headers);
        res.end(html);
      });
    });
    return;
  }
  // Pour les autres types de fichiers (css, js, images, wasm, etc.)
  res.writeHead(proxyRes.statusCode, headers);
  proxyRes.pipe(res);
}

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