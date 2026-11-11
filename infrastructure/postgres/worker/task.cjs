const fs = require('node:fs')
const { apply, validatePlan, verifyRuntime, pgClient, identity, decode, ProvisionError } = require('./provisioner.cjs')
const { createStore, StoreError } = require('./credential-store.cjs')
const emit = result => console.log('CATALOG_RESULT ' + JSON.stringify(result))
function binding(name) {
  const matches = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat().filter(b=>b.name===name)
  if (!name || matches.length !== 1) throw new ProvisionError('BINDING_REQUIRED')
  return matches[0].credentials
}
function managedConnection(c) {
  const result = {host:c.hostname||c.host,port:Number(c.port||5432),database:c.dbname||c.database,user:c.username||c.user,password:c.password,
    ssl:{ca:c.sslrootcert,rejectUnauthorized:true}}
  if (!result.host || !result.database || !result.user || !result.password || !result.ssl.ca || !Number.isInteger(result.port)) throw new ProvisionError('SECURE_POSTGRES_BINDING_REQUIRED')
  return result
}
async function main() {
  const plan = JSON.parse(fs.readFileSync('catalog-plan.json','utf8'))
  validatePlan(plan)
  const mode = process.argv[2]
  const store = createStore(binding(process.env.CATALOG_STORE_SERVICE))
  if (mode==='apply') {
    const admin = managedConnection(binding(process.env.CATALOG_POSTGRES_SERVICE))
    await apply({plan,admin,store,emit,checkpoint:async(phase,app)=>emit({app_id:app.app_id,phase})})
    emit({ok:true,mode,applications:plan.applications.length,crossDatabaseDenied:true})
  } else if (mode==='check') {
    const app = plan.applications.find(a=>a.app_id===process.env.CATALOG_CHECK_APP)
    if (!app) throw new ProvisionError('CHECK_APP_REQUIRED')
    const item = await store.read(app.credential_namespaces.runtime)
    let raw
    try { raw=JSON.parse(Buffer.from(item.value,'base64').toString()) } catch { throw new ProvisionError('INVALID_STORED_CREDENTIAL') }
    if (!raw.ssl?.ca || raw.ssl.rejectUnauthorized!==true || raw.phase!=='ready') throw new ProvisionError('READY_TLS_CREDENTIAL_REQUIRED')
    const connection = decode(item,identity(app,plan.instance_guid),{host:raw.host,port:Number(raw.port),ssl:raw.ssl})
    if (connection.user!==identity(app,plan.instance_guid).runtime) throw new ProvisionError('RUNTIME_IDENTITY_MISMATCH')
    await verifyRuntime(pgClient,connection,plan.applications.filter(a=>a.app_id!==app.app_id).map(a=>a.postgres.database))
    for (const namespace of [app.credential_namespaces.deployer,...plan.applications.filter(a=>a.app_id!==app.app_id).map(a=>a.credential_namespaces.runtime)]) {
      let denied=false
      try { await store.read(namespace) } catch(error) { if(error.status!==403) throw error; denied=true }
      if (!denied) throw new ProvisionError('UNEXPECTED_SECRET_ACCESS')
    }
    emit({ok:true,mode,app_id:app.app_id,runtimeDdlDenied:true,crossDatabaseDenied:true,otherSecretsDenied:true})
  } else throw new ProvisionError('INVALID_MODE')
}
if (require.main===module) main().catch(error=>{
  emit({ok:false,errorCode:error instanceof ProvisionError || error instanceof StoreError ? error.code : (/^[0-9A-Z]{5}$/.test(error.code||'') ? error.code : 'TASK_FAILED'),httpStatus:Number(error.status)||undefined})
  process.exitCode=1
})
module.exports = {managedConnection,binding}
