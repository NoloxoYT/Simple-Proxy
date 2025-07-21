async function fetchConfig() {
  const res = await fetch('/api/config');
  const data = await res.json();
  document.getElementById('target').value = data.target;
  document.getElementById('port').value = data.port;
  document.getElementById('https').value = data.https ? 'true' : 'false';
}

async function fetchLogs() {
  const res = await fetch('/api/logs');
  const logs = await res.text();
  document.getElementById('logs').textContent = logs;
}

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = document.getElementById('target').value;
  const port = document.getElementById('port').value;
  const https = document.getElementById('https').value === 'true';
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, port, https })
  });
  const msg = await res.text();
  document.getElementById('config-status').textContent = msg;
  fetchConfig();
});

document.getElementById('test-conn').addEventListener('click', async () => {
  const res = await fetch('/api/test');
  const data = await res.json();
  document.getElementById('test-result').textContent = data.ok ? '✅ Succès' : '❌ Échec';
});

fetchConfig();
fetchLogs();
setInterval(fetchLogs, 5000); 