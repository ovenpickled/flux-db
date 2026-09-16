'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '1234', 10);
const SERVER_BIN = process.env.SERVER_BIN || path.join(__dirname, '..', 'bin', 'server');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AOF_PATH = path.join(DATA_DIR, 'aof.log');

const MAX_GLOBAL_CONNECTIONS = parseInt(process.env.MAX_GLOBAL_CONNECTIONS || '20', 10);
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '3', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const RESET_INTERVAL_MS = parseInt(process.env.RESET_INTERVAL_MS || String(30 * 60 * 1000), 10);

const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_CMDS = 40; 

const MAX_LINE_LEN = 512;   
const MAX_TOKENS = 8;        
const MAX_TOKEN_LEN = 256;   
const MAX_ARRAY_ITEMS_SHOWN = 200; 
const MAX_DECODE_DEPTH = 16;    

const TAG = { NIL: 0, ERR: 1, STR: 2, INT: 3, DBL: 4, ARR: 5 };

function encodeRequest(tokens) {
  let payloadLen = 4;
  for (const t of tokens) payloadLen += 4 + Buffer.byteLength(t, 'utf8');

  const buf = Buffer.alloc(4 + payloadLen);
  let off = 0;
  buf.writeUInt32LE(payloadLen, off); off += 4;
  buf.writeUInt32LE(tokens.length, off); off += 4;
  for (const t of tokens) {
    const b = Buffer.from(t, 'utf8');
    buf.writeUInt32LE(b.length, off); off += 4;
    b.copy(buf, off); off += b.length;
  }
  return buf;
}

function sanitizeForDisplay(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code === 0x1b) { out += '\\x1b'; continue; }
    if (code < 0x20 && code !== 0x0a) { out += `\\x${code.toString(16).padStart(2, '0')}`; continue; }
    if (code === 0x7f) { out += '\\x7f'; continue; }
    out += ch;
  }
  return out;
}

function quoteStr(str) {
  return '"' + sanitizeForDisplay(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}


function decodeValue(buf, off, depth) {
  if (depth > MAX_DECODE_DEPTH) throw new Error('response nested too deeply');
  if (off >= buf.length) throw new Error('truncated response');

  const tag = buf[off];
  switch (tag) {
    case TAG.NIL:
      return { text: '(nil)', next: off + 1 };

    case TAG.ERR: {
      const code = buf.readInt32LE(off + 1);
      const len = buf.readUInt32LE(off + 5);
      const start = off + 9;
      const msg = buf.toString('utf8', start, start + len);
      return { text: `(error) [${code}] ${sanitizeForDisplay(msg)}`, next: start + len };
    }

    case TAG.STR: {
      const len = buf.readUInt32LE(off + 1);
      const start = off + 5;
      const s = buf.toString('utf8', start, start + len);
      return { text: quoteStr(s), next: start + len };
    }

    case TAG.INT: {
      const val = buf.readBigInt64LE(off + 1);
      return { text: `(integer) ${val.toString()}`, next: off + 9 };
    }

    case TAG.DBL: {
      const val = buf.readDoubleLE(off + 1);
      return { text: `(double) ${val}`, next: off + 9 };
    }

    case TAG.ARR: {
      const n = buf.readUInt32LE(off + 1);
      let cur = off + 5;
      if (n === 0) return { text: '(empty array)', next: cur };
      const lines = [];
      const shown = Math.min(n, MAX_ARRAY_ITEMS_SHOWN);
      for (let i = 0; i < n; i++) {
        const { text, next } = decodeValue(buf, cur, depth + 1);
        cur = next;
        if (i < shown) lines.push(`${i + 1}) ${text}`);
      }
      if (n > shown) lines.push(`... (${n - shown} more items truncated)`);
      return { text: lines.join('\n'), next: cur };
    }

    default:
      throw new Error(`unknown tag byte ${tag}`);
  }
}

function decodeResponse(buf) {
  const { text } = decodeValue(buf, 0, 0);
  return text;
}

const COMMANDS = {
  get: { argc: 2, usage: 'get <key>' },
  set: { argc: 3, usage: 'set <key> <value>' },
  del: { argc: 2, usage: 'del <key>' },
  pexpire: { argc: 3, usage: 'pexpire <key> <ms>' },
  pttl: { argc: 2, usage: 'pttl <key>' },
  keys: { argc: 1, usage: 'keys' },
  zadd: { argc: 4, usage: 'zadd <key> <score> <member>' },
  zrem: { argc: 3, usage: 'zrem <key> <member>' },
  zscore: { argc: 3, usage: 'zscore <key> <member>' },
  zquery: { argc: 6, usage: 'zquery <key> <min_score> <min_member> <offset> <limit>' },
};

const HELP_TEXT = [
  'Commands (same protocol the real client.cpp speaks, live against the actual server):',
  ...Object.values(COMMANDS).map((c) => '  ' + c.usage),
  '',
  'Try:',
  '  set greeting "hello world"',
  '  get greeting',
  '  zadd leaderboard 100 alice',
  '  zadd leaderboard 250 bob',
  '  zquery leaderboard 0 "" 0 10',
  '',
  'Note: this is a shared public demo. Data may be wiped periodically and is not private.',
].join('\n');

function tokenize(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let tok = '';
    if (line[i] === '"') {
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < n) { tok += line[i + 1]; i += 2; }
        else { tok += line[i]; i++; }
      }
      i++; 
    } else {
      while (i < n && !/\s/.test(line[i])) { tok += line[i]; i++; }
    }
    tokens.push(tok);
    if (tokens.length > MAX_TOKENS) break;
  }
  return tokens;
}

let backendChild = null;
let backendReady = false;
let crashCount = 0;
let wipeAofOnRestart = false;
let shuttingDown = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function probeBackend(cb) {
  const sock = net.connect(BACKEND_PORT, BACKEND_HOST);
  sock.once('connect', () => { sock.destroy(); cb(true); });
  sock.once('error', () => { sock.destroy(); cb(false); });
}

function waitForBackendReady(deadline) {
  probeBackend((ok) => {
    if (ok) {
      backendReady = true;
      log('backend ready');
      return;
    }
    if (Date.now() > deadline) {
      log('backend did not become ready in time');
      return;
    }
    setTimeout(() => waitForBackendReady(deadline), 150);
  });
}

function spawnBackend() {
  if (shuttingDown) return;

  if (wipeAofOnRestart) {
    try { fs.unlinkSync(AOF_PATH); log('wiped', AOF_PATH); }
    catch (e) { /* fine if it didn't exist */ }
    wipeAofOnRestart = false;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  log('starting backend:', SERVER_BIN, 'cwd=', DATA_DIR);
  backendReady = false;
  const child = spawn(SERVER_BIN, [], { cwd: DATA_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  backendChild = child;
  const startedAt = Date.now();

  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  child.on('exit', (code, signal) => {
    log(`backend exited (code=${code}, signal=${signal})`);
    backendReady = false;
    backendChild = null;

    for (const client of activeSessions) client.notifyBackendDown();

    if (shuttingDown) return;

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > 10_000) crashCount = 0; 
    else crashCount++;

    const delay = Math.min(30_000, 1000 * 2 ** crashCount);
    log(`respawning backend in ${delay}ms (crashCount=${crashCount})`);
    setTimeout(spawnBackend, delay);
  });

  waitForBackendReady(Date.now() + 5000);
}

setInterval(() => {
  if (!backendChild) return;
  log('scheduled reset: recycling backend + wiping AOF');
  wipeAofOnRestart = true;
  backendChild.kill('SIGTERM');
  setTimeout(() => { if (backendChild) backendChild.kill('SIGKILL'); }, 3000);
}, RESET_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(400); res.end('bad request'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const httpServer = http.createServer(serveStatic);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 4096 });

const activeSessions = new Set();
const connectionsPerIp = new Map(); 

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; 
  const allowlist = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length > 0) return allowlist.includes(origin);
  try {
    const originHost = new URL(origin).host;
    return originHost === req.headers.host;
  } catch { return false; }
}

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  if (!originAllowed(req)) { log('rejected upgrade: bad origin', req.headers.origin); socket.destroy(); return; }

  const ip = clientIp(req);
  if (activeSessions.size >= MAX_GLOBAL_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
  }
  if ((connectionsPerIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
});

class Session {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.backendSocket = null;
    this.recvBuf = Buffer.alloc(0);
    this.cmdTimestamps = [];
    this.idleTimer = null;
    this.destroyed = false;

    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
    activeSessions.add(this);

    ws.send(sanitizeForDisplay(HELP_TEXT));
    this.armIdleTimer();

    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.destroy());
    ws.on('error', () => this.destroy());
  }

  armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.send('(closing idle connection)');
      this.destroy();
    }, IDLE_TIMEOUT_MS);
  }

  send(text) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  notifyBackendDown() {
    if (this.backendSocket) { this.backendSocket.destroy(); this.backendSocket = null; }
    this.send('(the demo server is restarting - your next command will reconnect automatically)');
  }

  rateLimited() {
    const now = Date.now();
    this.cmdTimestamps = this.cmdTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.cmdTimestamps.length >= RATE_LIMIT_MAX_CMDS) return true;
    this.cmdTimestamps.push(now);
    return false;
  }

  ensureBackendSocket() {
    if (this.backendSocket) return this.backendSocket;
    const sock = net.connect(BACKEND_PORT, BACKEND_HOST);
    sock.on('data', (chunk) => this.onBackendData(chunk));
    sock.on('error', () => { this.send('(error) lost connection to backend'); this.backendSocket = null; });
    sock.on('close', () => { this.backendSocket = null; });
    this.backendSocket = sock;
    return sock;
  }

  onBackendData(chunk) {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    while (this.recvBuf.length >= 4) {
      const len = this.recvBuf.readUInt32LE(0);
      if (this.recvBuf.length < 4 + len) break; 
      const body = this.recvBuf.subarray(4, 4 + len);
      this.recvBuf = this.recvBuf.subarray(4 + len);
      try {
        this.send(decodeResponse(body));
      } catch (e) {
        this.send('(error) could not decode server response');
      }
    }
  }

  onMessage(data) {
    if (this.destroyed) return;
    this.armIdleTimer();

    if (!backendReady) { this.send('(the demo server is warming up, try again in a few seconds)'); return; }
    if (this.rateLimited()) { this.send('(rate limit exceeded - slow down a little)'); return; }

    const line = data.toString('utf8', 0, Math.min(data.length, MAX_LINE_LEN));
    if (data.length > MAX_LINE_LEN) { this.send(`(error) line too long (max ${MAX_LINE_LEN} bytes)`); return; }

    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed === 'help') { this.send(HELP_TEXT); return; }

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return;
    if (tokens.length > MAX_TOKENS) { this.send(`(error) too many arguments (max ${MAX_TOKENS})`); return; }
    if (tokens.some((t) => t.length > MAX_TOKEN_LEN)) { this.send(`(error) argument too long (max ${MAX_TOKEN_LEN} bytes)`); return; }

    const spec = COMMANDS[tokens[0].toLowerCase()];
    if (!spec) { this.send(`(error) unknown command '${tokens[0]}'. Type 'help' for the command list.`); return; }
    tokens[0] = tokens[0].toLowerCase();
    if (tokens.length !== spec.argc) { this.send(`(error) wrong number of arguments. usage: ${spec.usage}`); return; }

    try {
      const req = encodeRequest(tokens);
      this.ensureBackendSocket().write(req);
    } catch (e) {
      this.send('(error) could not send command to backend');
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.idleTimer);
    if (this.backendSocket) this.backendSocket.destroy();
    try { this.ws.close(); } catch (e) { /* already closing */ }
    activeSessions.delete(this);
    const n = (connectionsPerIp.get(this.ip) || 1) - 1;
    if (n <= 0) connectionsPerIp.delete(this.ip); else connectionsPerIp.set(this.ip, n);
  }
}

wss.on('connection', (ws, req, ip) => new Session(ws, ip));

httpServer.listen(PORT, () => log(`listening on :${PORT}`));
spawnBackend();

function shutdown() {
  shuttingDown = true;
  log('shutting down');
  if (backendChild) backendChild.kill('SIGTERM');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);