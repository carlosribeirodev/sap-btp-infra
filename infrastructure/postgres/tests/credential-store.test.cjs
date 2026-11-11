const {test}=require('node:test')
const assert=require('node:assert/strict')
const {EventEmitter}=require('node:events')
const {generateKeyPairSync}=require('node:crypto')
const {createStore,seal,unseal}=require('../worker/credential-store.cjs')
const keys=()=>generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}})
const server=keys(),client=keys()
const binding={url:'https://vault.example.invalid/api/v1/credentials',certificate:'test certificate',key:'test key',encryption:{server_public_key:server.publicKey,client_private_key:client.privateKey}}
function transport(handler){return {request(url,options,callback){
 const req=new EventEmitter();req.setTimeout=()=>{};req.end=body=>queueMicrotask(()=>{
  const result=handler(url,options,body),res=new EventEmitter();res.statusCode=result.status;callback(res)
  if(result.value)res.emit('data',Buffer.from(seal(result.value,client.publicKey)))
  res.emit('end')
 });return req
}}}
test('create/update use conditional writes, mTLS and encrypted payloads',async()=>{
 const calls=[]
 const store=createStore(binding,transport((url,options,body)=>{
  calls.push(options);assert.equal(options.rejectUnauthorized,true);assert.equal(options.cert,binding.certificate)
  assert(!body.includes('SYNTHETIC_SECRET'));assert.equal(unseal(body,server.privateKey).value,'SYNTHETIC_SECRET')
  return {status:200,value:{id:'stored'}}
 }))
 await store.create('dev-app-runtime',{name:'postgres',value:'SYNTHETIC_SECRET'})
 await store.update('dev-app-runtime',{name:'postgres',value:'SYNTHETIC_SECRET'})
 assert.equal(calls[0].headers['If-None-Match'],'*');assert.equal(calls[1].headers['If-Match'],'*')
})
test('only not-found becomes an absent credential; denied and conflict fail closed',async()=>{
 for(const status of [403,409,412,500]) {
  const store=createStore(binding,transport(()=>({status})))
  await assert.rejects(store.read('namespace'),e=>e.status===status && !e.message.includes('test key'))
 }
 assert.equal(await createStore(binding,transport(()=>({status:404}))).read('namespace'),null)
})
test('reject incomplete binding and authenticated ciphertext tampering',()=>{
 assert.throws(()=>createStore({...binding,key:undefined}))
 const parts=seal({value:'secret'},server.publicKey).split('.')
 const tag=Buffer.from(parts[4],'base64url');tag[0]^=1;parts[4]=tag.toString('base64url')
 assert.throws(()=>unseal(parts.join('.'),server.privateKey))
})
