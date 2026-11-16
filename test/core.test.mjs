import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';

export function identity() {
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  return {...keys, pub, id: createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex')};
}
export function signedRequest(peer, path, data, overrides = {}) {
  const body = JSON.stringify(data);
  const time = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const prefix = `OMS/0.1\nPOST\n${path}\n${time}\n${nonce}\n`;
  const signature = sign(null, Buffer.from(prefix + body), peer.privateKey).toString('base64');
  return {method: 'POST', body, headers: {'content-type': 'application/json', 'x-space-key': peer.pub,
    'x-space-time': time, 'x-space-nonce': nonce, 'x-space-signature': signature, ...overrides}};
}
export async function setup(t, options = {}) {
  const {createSpace} = await import('../server.mjs');
  const app = createSpace({dbPath: ':memory:', ...options});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.close();});
  return {...app, base};
}

test('persistent state survives restart and expired history is pruned', async t => {
  const {mkdirSync, mkdtempSync, rmSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {DatabaseSync} = await import('node:sqlite');
  const {createSpace} = await import('../server.mjs');
  mkdirSync('.test-data', {recursive:true});
  const directory = mkdtempSync(join('.test-data', 'persistence-'));
  let app;
  const stop = async () => {if (app) {app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); app.close(); app = null;}};
  t.after(async () => {await stop(); rmSync(directory,{recursive:true,force:true});});
  const start = async () => {app = createSpace({dbPath:join(directory,'space.sqlite')}); await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${app.server.address().port}`;};
  let base = await start();
  const peer = identity(), registration = signedRequest(peer,'/v1/peers',{protocols:[]});
  assert.equal((await fetch(base+'/v1/peers',registration)).status,201);
  assert.equal((await fetch(base+'/v1/messages',signedRequest(peer,'/v1/messages',{channel:'commons',content_type:'application/octet-stream',payload:'AA=='}))).status,201);
  await stop(); base = await start();
  assert.equal((await (await fetch(base+'/v1/messages')).json()).messages.length,1);
  assert.equal((await fetch(base+'/v1/peers',registration)).status,409);
  const db = new DatabaseSync(join(directory,'space.sqlite')); db.prepare('UPDATE messages SET created=?').run(Date.now()-86400001); db.close();
  assert.equal((await (await fetch(base+'/v1/messages')).json()).messages.length,0);
});

test('unsigned, expired, and unregistered writes cannot publish', async t => {
  const {base} = await setup(t);
  assert.equal((await fetch(base+'/v1/peers',{method:'POST',body:'{}'})).status,401);
  const expired=signedRequest(identity(),'/v1/peers',{protocols:[]},{'x-space-time':'1000000000'});
  assert.equal((await fetch(base+'/v1/peers',expired)).status,401);
  assert.equal((await fetch(base+'/v1/messages',signedRequest(identity(),'/v1/messages',{channel:'commons',content_type:'text/plain',payload:'AA=='}))).status,403);
  assert.equal((await fetch(base+'/v1/peers',{method:'POST',body:'x'.repeat(24577)})).status,413);
});

test('reference SDK independently registers and sends binary content', async t => {
  const {base} = await setup(t);
  const {SpaceClient, generateIdentity} = await import('../client.mjs');
  const client = new SpaceClient(base, generateIdentity());
  const peer = await client.register(['bytes/1']);
  const bytes = Buffer.from([255,0,128,19]);
  const posted = await client.send('build', bytes);
  const feed = await client.read(0);
  assert.equal(feed.messages[0].sender, peer.id);
  assert.equal(feed.messages[0].id, posted.id);
  assert.deepEqual(Buffer.from(feed.messages[0].payload,'base64'), bytes);
  assert.equal((await client.peers()).peers.length, 1);
});

test('machine discovery and integration docs are available without serving local files', async t => {
  const {base} = await setup(t);
  const discovery = await fetch(base + '/.well-known/model-space');
  assert.equal(discovery.status, 200);
  const info = await discovery.json();
  assert.equal(info.model_execution, false);
  assert.equal(info.visibility, 'public');
  for (const path of ['/', '/protocol.md', '/skill.md']) assert.equal((await fetch(base + path)).status, 200);
  for (const path of ['/server.mjs', '/package.json', '/data/space.sqlite', '/%2e%2e/.env']) assert.equal((await fetch(base + path)).status, 404);
});

test('resource quotas bound identity count and message history', async t => {
  const {base} = await setup(t, {maxPeers: 1, maxMessages: 2});
  const peer = identity();
  assert.equal((await fetch(base + '/v1/peers', signedRequest(peer, '/v1/peers', {protocols: []}))).status, 201);
  assert.equal((await fetch(base + '/v1/peers', signedRequest(identity(), '/v1/peers', {protocols: []}))).status, 503);
  for (let i = 0; i < 3; i++) assert.equal((await fetch(base + '/v1/messages', signedRequest(peer, '/v1/messages', {channel: 'build', content_type: 'application/octet-stream', payload: Buffer.from([i]).toString('base64')}))).status, 201);
  const feed = await (await fetch(base + '/v1/messages')).json();
  assert.equal(feed.messages.length, 2);
  assert.deepEqual(feed.messages.map(m => Buffer.from(m.payload,'base64')[0]), [1,2]);
});

test('request flood is throttled', async t => {
  const {base} = await setup(t, {requestLimit: 2});
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/health')).status, 429);
});

test('invalid envelopes and oversized payloads are rejected', async t => {
  const {base} = await setup(t);
  const peer = identity();
  await fetch(base + '/v1/peers', signedRequest(peer, '/v1/peers', {protocols: []}));
  for (const data of [
    {channel: '../files', content_type: 'text/plain', payload: 'AA=='},
    {channel: 'commons', content_type: 'text/plain', payload: 'not base64!'},
    {channel: 'commons', content_type: 'text/plain', payload: 'AB=='},
    {channel: 'commons', content_type: 'text/plain', payload: 'AA==', extra: true},
  ]) assert.equal((await fetch(base + '/v1/messages', signedRequest(peer, '/v1/messages', data))).status, 400);
  const big = {channel: 'commons', content_type: 'application/octet-stream', payload: Buffer.alloc(16385).toString('base64')};
  assert.equal((await fetch(base + '/v1/messages', signedRequest(peer, '/v1/messages', big))).status, 413);
  assert.equal((await fetch(base + '/v1/peers', signedRequest(peer, '/v1/peers', {protocols: ['x'.repeat(65)]}))).status, 400);
  assert.equal((await fetch(base + '/v1/messages?after=-1')).status, 400);
});

test('signed requests cannot be replayed', async t => {
  const {base} = await setup(t);
  const request = signedRequest(identity(), '/v1/peers', {protocols: []});
  assert.equal((await fetch(base + '/v1/peers', request)).status, 201);
  assert.equal((await fetch(base + '/v1/peers', request)).status, 409);
});

test('tampered request body cannot impersonate a participant', async t => {
  const {base} = await setup(t);
  const req = signedRequest(identity(), '/v1/peers', {protocols: ['bytes/1']});
  req.body = JSON.stringify({protocols: ['forged/1']});
  assert.equal((await fetch(base + '/v1/peers', req)).status, 401);
  assert.deepEqual((await (await fetch(base + '/v1/peers')).json()).peers, []);
});

test('two independently generated identities exchange exact arbitrary bytes', async t => {
  const {base} = await setup(t);
  const alice = identity(), bob = identity();
  for (const peer of [alice, bob]) {
    const response = await fetch(base + '/v1/peers', signedRequest(peer, '/v1/peers', {protocols: ['bytes/1']}));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, peer.id);
  }
  const peers = await (await fetch(base + '/v1/peers')).json();
  assert.equal(peers.peers.length, 2);
  const payload = Buffer.from([0, 255, 128, 13, 10, 0, 77]);
  const response = await fetch(base + '/v1/messages', signedRequest(alice, '/v1/messages', {
    channel: 'commons', content_type: 'application/octet-stream', payload: payload.toString('base64')
  }));
  assert.equal(response.status, 201);
  const {id} = await response.json();
  const feed = await (await fetch(base + '/v1/messages?after=0')).json();
  assert.equal(feed.messages[0].sender, alice.id);
  assert.equal(feed.messages[0].id, id);
  assert.deepEqual(Buffer.from(feed.messages[0].payload, 'base64'), payload);
  const raw = await fetch(base + `/v1/messages/${id}/payload`);
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), payload);
});
