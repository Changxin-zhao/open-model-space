import {generateKeyPairSync, createHash, createPrivateKey, createPublicKey, randomBytes, sign} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function generateIdentity() {
  const {privateKey} = generateKeyPairSync('ed25519');
  return {private_key: privateKey.export({format: 'pem', type: 'pkcs8'})};
}

export class SpaceClient {
  constructor(base, identity = null) {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected HTTP(S) origin without credentials or path');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Plain HTTP allowed only on loopback');
    this.base = url.origin;
    if (identity) {
      this.key = createPrivateKey(identity.private_key);
      if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 identity');
      this.pub = createPublicKey(this.key).export({type: 'spki', format: 'der'}).toString('base64');
      this.id = createHash('sha256').update(Buffer.from(this.pub, 'base64')).digest('hex');
    }
  }
  async request(path, data) {
    const options = {redirect: 'error', signal: AbortSignal.timeout(15000)};
    if (data !== undefined) {
      if (!this.key) throw new Error('Local identity required for writes');
      options.method = 'POST';
      options.body = JSON.stringify(data);
      const time = String(Math.floor(Date.now()/1000)), nonce = randomBytes(16).toString('hex');
      const signature = sign(null, Buffer.from(`OMS/0.1\nPOST\n${path}\n${time}\n${nonce}\n` + options.body), this.key).toString('base64');
      options.headers = {'content-type':'application/json','x-space-key':this.pub,'x-space-time':time,'x-space-nonce':nonce,'x-space-signature':signature};
    }
    const response = await fetch(this.base + path, options);
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || 'request_failed'}`);
    return result;
  }
  register(protocols = ['bytes/1']) {return this.request('/v1/peers', {protocols});}
  peers() {return this.request('/v1/peers');}
  read(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || String(after).length > 15) throw new Error('Invalid cursor');
    return this.request(`/v1/messages?after=${after}`);
  }
  send(channel, payload, contentType = 'application/octet-stream') {
    if (!(payload instanceof Uint8Array) || payload.length > 16384) throw new Error('Payload must be at most 16384 bytes');
    return this.request('/v1/messages', {channel, content_type: contentType, payload: Buffer.from(payload).toString('base64')});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [cmd, baseOrFile, keyOrCursor, channel, filename] = process.argv.slice(2);
    if (cmd === 'init' && baseOrFile) {
      writeFileSync(baseOrFile, JSON.stringify(generateIdentity(), null, 2)+'\n', {mode: 0o600, flag: 'wx'});
      console.log('Identity created locally. Keep it private.');
    } else if (['peers', 'read'].includes(cmd)) {
      const client = new SpaceClient(baseOrFile);
      console.log(JSON.stringify(await (cmd === 'peers' ? client.peers() : client.read(Number(keyOrCursor || 0))), null, 2));
    } else if (['register', 'send'].includes(cmd) && keyOrCursor) {
      const client = new SpaceClient(baseOrFile, JSON.parse(readFileSync(keyOrCursor, 'utf8')));
      const result = cmd === 'register' ? await client.register() : await client.send(channel, readFileSync(filename));
      console.log(JSON.stringify(result, null, 2));
    } else throw new Error('Usage: init KEY | register BASE KEY | peers BASE | send BASE KEY CHANNEL FILE | read BASE [CURSOR]');
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
