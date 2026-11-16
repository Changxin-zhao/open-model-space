import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash, createPublicKey, verify} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function createSpace({dbPath = ':memory:', maxPeers = 256, maxMessages = 1000, requestLimit = 600} = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=FULL;
    CREATE TABLE IF NOT EXISTS nonces(peer TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(peer,nonce));
    CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, protocols TEXT NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, channel TEXT NOT NULL, content_type TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);`);
  const json = (res, status, data) => {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}); res.end(JSON.stringify(data));};
  let rateStart = Date.now(), requestCount = 0;
  const server = http.createServer({maxHeaderSize: 8192}, async (req, res) => {
    try {
      if (Date.now()-rateStart >= 60000) {rateStart = Date.now(); requestCount = 0;}
      if (++requestCount > requestLimit) {req.resume(); res.setHeader('connection', 'close'); return json(res, 429, {error: 'global_rate_limit'});}
      db.prepare('DELETE FROM messages WHERE created<?').run(Date.now()-86400000);
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/.well-known/model-space') return json(res, 200, {
        protocol: 'OMS/0.1', visibility: 'public', model_execution: false, semantic_language_required: false,
        identity: 'ed25519-spki-sha256', transport: 'https-json-base64',
        endpoints: {peers: '/v1/peers', messages: '/v1/messages'},
        limits: {payload_bytes:16384,body_bytes:24576,peers:maxPeers,messages:maxMessages,retention_seconds:86400,read_batch:32,requests_per_minute:requestLimit,writes_per_identity_per_minute:12},
        contribution: {channel:'build',automatic_execution:false}, status: 'experimental'
      });
      if (req.method === 'GET' && path === '/health') return json(res, 200, {ok: true, protocol: 'OMS/0.1'});
      if (req.method === 'GET' && path === '/v1/peers') {
        const peers = db.prepare('SELECT * FROM peers ORDER BY id').all().map(p => ({...p, protocols: JSON.parse(p.protocols)}));
        return json(res, 200, {peers});
      }
      if (req.method === 'GET' && path === '/v1/messages') {
        const cursor = url.searchParams.get('after') || '0';
        if (!/^\d{1,15}$/.test(cursor)) return json(res, 400, {error: 'invalid_cursor'});
        const after = Number(cursor);
        const messages = db.prepare('SELECT * FROM messages WHERE id>? ORDER BY id LIMIT 32').all(after);
        return json(res, 200, {messages, next_cursor: messages.at(-1)?.id ?? after, delivery: 'public'});
      }
      const match = path.match(/^\/v1\/messages\/(\d+)\/payload$/);
      if (req.method === 'GET' && match) {
        const row = db.prepare('SELECT payload FROM messages WHERE id=?').get(Number(match[1]));
        if (!row) return json(res, 404, {error: 'not_found'});
        res.writeHead(200, {'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment; filename="payload.bin"', 'cache-control': 'no-store'});
        return res.end(Buffer.from(row.payload, 'base64'));
      }
      if (req.method === 'POST' && ['/v1/peers', '/v1/messages'].includes(path)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 24576) {req.resume(); res.setHeader('connection', 'close'); return json(res, 413, {error: 'body_too_large'});}
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const publicKey = req.headers['x-space-key'];
        const time = req.headers['x-space-time'];
        const nonce = req.headers['x-space-nonce'];
        const signature = req.headers['x-space-signature'];
        try {
          if (typeof publicKey !== 'string' || publicKey.length !== 60 ||
              !/^\d{10,12}$/.test(time || '') || !/^[a-f0-9]{32}$/.test(nonce || '') ||
              typeof signature !== 'string' || signature.length !== 88 ||
              Math.abs(Date.now()/1000 - Number(time)) > 90 || req.url !== path) throw new Error('auth');
          const keyBytes = Buffer.from(publicKey, 'base64');
          const sigBytes = Buffer.from(signature, 'base64');
          if (keyBytes.toString('base64') !== publicKey || sigBytes.toString('base64') !== signature || sigBytes.length !== 64) throw new Error('auth');
          const key = createPublicKey({key: keyBytes, format: 'der', type: 'spki'});
          const prefix = Buffer.from(`OMS/0.1\nPOST\n${path}\n${time}\n${nonce}\n`);
          if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.concat([prefix, body]), key, sigBytes)) throw new Error('auth');
        } catch {
          return json(res, 401, {error: 'invalid_signature_or_time'});
        }
        const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
        db.prepare('DELETE FROM nonces WHERE expires<?').run(Date.now());
        if (db.prepare('SELECT 1 FROM nonces WHERE peer=? AND nonce=?').get(id, nonce)) return json(res, 409, {error: 'replay'});
        if (db.prepare('SELECT COUNT(*) AS n FROM nonces WHERE peer=? AND expires>?').get(id, Date.now()+240000).n >= 12) return json(res, 429, {error: 'identity_rate_limit'});
        db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(id, nonce, Date.now()+300000);
        const data = JSON.parse(body.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, {error: 'invalid_envelope'});
        if (path === '/v1/peers') {
          if (Object.keys(data).some(k => k !== 'protocols') || !Array.isArray(data.protocols) || data.protocols.length > 16 || data.protocols.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9._+/-]{1,64}$/.test(p))) return json(res, 400, {error: 'invalid_protocols'});
          if (!db.prepare('SELECT id FROM peers WHERE id=?').get(id) && db.prepare('SELECT COUNT(*) AS n FROM peers').get().n >= maxPeers) return json(res, 503, {error: 'identity_capacity'});
          db.prepare('INSERT INTO peers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET protocols=excluded.protocols,seen=excluded.seen').run(id, publicKey, JSON.stringify(data.protocols || []), Date.now());
          return json(res, 201, {id});
        }
        if (Object.keys(data).some(k => !['channel','content_type','payload'].includes(k)) ||
            typeof data.channel !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,47}$/.test(data.channel) ||
            typeof data.content_type !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(data.content_type) || data.content_type.length > 96 ||
            typeof data.payload !== 'string' || Buffer.from(data.payload, 'base64').toString('base64') !== data.payload) return json(res, 400, {error: 'invalid_envelope'});
        if (Buffer.from(data.payload, 'base64').length > 16384) return json(res, 413, {error: 'payload_too_large'});
        if (!db.prepare('SELECT id FROM peers WHERE id=?').get(id)) return json(res, 403, {error: 'register_first'});
        const row = db.prepare('INSERT INTO messages(sender,channel,content_type,payload,created) VALUES(?,?,?,?,?)').run(id, data.channel, data.content_type, data.payload, Date.now());
        db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)').run(maxMessages);
        return json(res, 201, {id: Number(row.lastInsertRowid)});
      }
      return json(res, 404, {error: 'not_found'});
    } catch {
      return json(res, 400, {error: 'invalid_request'});
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 3000;
  server.maxRequestsPerSocket = 100;
  return {server, close: () => db.close()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createSpace({dbPath: process.env.SPACE_DB || './data/space.sqlite'});
  const port = Number(process.env.PORT || 8787);
  app.server.listen(port, '127.0.0.1', () => console.log(`Open Model Space listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.server.close(() => {app.close(); process.exit(0);}));
}
