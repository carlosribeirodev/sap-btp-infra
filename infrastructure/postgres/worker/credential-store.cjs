// SAP Credential Store: mTLS transport and encrypted JWE payloads.
// Never include response bodies, bindings or underlying exceptions in logs.
const https = require('node:https')
const crypto = require('node:crypto')
const pem = (value, type) => value.includes('-----BEGIN') ? value : `-----BEGIN ${type}-----\n${value}\n-----END ${type}-----`
const encode = value => Buffer.from(value).toString('base64url')
class StoreError extends Error {
  constructor(status) { super('Credential Store request failed'); this.code = 'CREDSTORE_REQUEST_FAILED'; this.status = status }
}
function seal(value, publicKey) {
  const header = encode(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', iat: Math.floor(Date.now()/1000) }))
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(header))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  const encrypted = crypto.publicEncrypt({ key: pem(publicKey, 'PUBLIC KEY'), oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, key)
  return [header, encode(encrypted), encode(iv), encode(ciphertext), encode(cipher.getAuthTag())].join('.')
}
function unseal(value, privateKey) {
  const pieces = value.split('.')
  if (pieces.length !== 5) throw new StoreError(0)
  const [header, encrypted, iv, ciphertext, tag] = pieces
  const spec = JSON.parse(Buffer.from(header, 'base64url'))
  if (spec.alg !== 'RSA-OAEP-256' || spec.enc !== 'A256GCM') throw new StoreError(0)
  const key = crypto.privateDecrypt({ key: pem(privateKey, 'PRIVATE KEY'), oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(encrypted, 'base64url'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(header)); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString())
}
function binding() {
  const matches = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat().filter(b => b.name === process.env.CATALOG_STORE_SERVICE)
  if (matches.length !== 1) throw new StoreError(0)
  return matches[0].credentials
}
function createStore(c = binding(), transport = https) {
  if (!c.certificate || !c.key || !c.encryption?.client_private_key || !c.encryption?.server_public_key) throw new StoreError(0)
  const base = new URL(c.url)
  if (base.protocol !== 'https:') throw new StoreError(0)
  async function request(namespace, method, name, value, condition) {
    const url = new URL(base.href.replace(/\/$/, '') + '/key')
    if (name) url.searchParams.set('name', name)
    const body = value ? seal(value, c.encryption.server_public_key) : undefined
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await new Promise((resolve, reject) => {
        const req = transport.request(url, { method, cert: c.certificate, key: c.key, rejectUnauthorized: true, headers: {
          'sapcp-credstore-namespace': namespace,
          'Cache-Control': 'no-store',
          ...(condition || {}),
          ...(body ? { 'Content-Type': 'application/jose', 'Content-Length': Buffer.byteLength(body) } : {})
        } }, res => {
          const chunks = []; let size = 0
          res.on('data', b => { size += b.length; if(size > 65536) res.destroy(new StoreError(0)); else chunks.push(b) })
          res.on('error', () => reject(new StoreError(0)))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
        })
        req.setTimeout(15000, () => req.destroy())
        req.on('error', () => reject(new StoreError(0)))
        req.end(body)
      })
      if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, (attempt+1)*1000)); continue }
      if (response.status < 200 || response.status >= 300) throw new StoreError(response.status)
      if (!response.body) return undefined
      try { return unseal(response.body, c.encryption.client_private_key) } catch { throw new StoreError(0) }
    }
    throw new StoreError(429)
  }
  return {
    async read(namespace, name = 'postgres') {
      try { return await request(namespace, 'GET', name) } catch (error) { if (error.status === 404) return null; throw error }
    },
    create(namespace, credential) { return request(namespace, 'POST', null, credential, {'If-None-Match':'*'}) },
    update(namespace, credential) { return request(namespace, 'POST', null, credential, {'If-Match':'*'}) }
  }
}
module.exports = { createStore, seal, unseal, StoreError }
