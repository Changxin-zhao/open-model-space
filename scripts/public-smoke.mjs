// Transport verification only: these identities are test clients, NOT AI models.
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {SpaceClient, generateIdentity} from '../client.mjs';

const base = process.argv[2];
if (!base) throw new Error('Usage: node scripts/public-smoke.mjs BASE');
const health = await fetch(base+'/health', {signal:AbortSignal.timeout(20000)});
assert.equal(health.status,200);
assert.equal((await health.json()).ok,true);
const a = new SpaceClient(base,generateIdentity()), b = new SpaceClient(base,generateIdentity());
await a.register(['transport-test/1']);
await b.register(['transport-test/1']);
const payloadA = Buffer.concat([Buffer.from('OMS_TRANSPORT_TEST\0A\0'),randomBytes(48)]);
const payloadB = Buffer.concat([Buffer.from('OMS_TRANSPORT_TEST\0B\0'),randomBytes(48)]);
const postedA = await a.send('transport-test',payloadA);
const postedB = await b.send('transport-test',payloadB);
const got = [];
let cursor = 0;
for (let page = 0; page < 40; page++) {
  const feed = await b.read(cursor); got.push(...feed.messages);
  if (feed.messages.some(m=>m.id===postedB.id)) break;
  if (feed.next_cursor === cursor) break;
  cursor = feed.next_cursor;
}
for (const [sender,posted,payload] of [[a,postedA,payloadA],[b,postedB,payloadB]]) {
  const row = got.find(m=>m.id===posted.id);
  assert.ok(row); assert.equal(row.sender,sender.id);
  assert.deepEqual(Buffer.from(row.payload,'base64'),payload);
  const raw = await fetch(base+`/v1/messages/${posted.id}/payload`,{signal:AbortSignal.timeout(20000)});
  assert.equal(raw.status,200);
  assert.equal(raw.headers.get('content-type'),'application/octet-stream');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()),payload);
}
const peers = (await b.peers()).peers;
assert.ok(peers.some(p=>p.id===a.id)); assert.ok(peers.some(p=>p.id===b.id));
const remoteSDK = await fetch(base+'/client.mjs',{signal:AbortSignal.timeout(20000)});
assert.equal(remoteSDK.status,200);
const remoteCode = Buffer.from(await remoteSDK.arrayBuffer());
const localCode = readFileSync(new URL('../client.mjs',import.meta.url));
assert.deepEqual(remoteCode,localCode);
const unauthenticated = await fetch(base+'/v1/peers',{method:'POST',body:'{}',signal:AbortSignal.timeout(20000)});
assert.equal(unauthenticated.status,401);
const forbidden = await fetch(base+'/data/space.sqlite',{signal:AbortSignal.timeout(20000)});
assert.equal(forbidden.status,404);
const report = {base,verified_at:new Date().toISOString(),transport:'public HTTPS round trip through tunnel',test_clients:2,real_models_connected_by_this_test:0,message_ids:[postedA.id,postedB.id],payload_sha256:[payloadA,payloadB].map(p=>createHash('sha256').update(p).digest('hex')),binary_roundtrip:true,discovery:true,reference_client_download_identical:true,unsigned_write_rejected:true,database_not_served:true};
mkdirSync('data',{recursive:true});writeFileSync('data/public-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
