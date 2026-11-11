// Requires an isolated PostgreSQL 16+ cluster, never a BTP/production connection.
const fs=require('node:fs')
const assert=require('node:assert/strict')
const {test,before,after}=require('node:test')
const {apply,pgClient,using,qi,scram,identity}=require('../worker/provisioner.cjs')
const config=JSON.parse(fs.readFileSync(process.env.CATALOG_TEST_CONFIG,'utf8'))
if(config.host!=='127.0.0.1'||config.database!=='postgres'||config.user!=='catalog_test_root') throw Error('Isolated test cluster required')
const admin={...config,user:'catalog_test_admin',database:'catalog_test_metadata'}
let root
const planFor=(...ids)=>({api_version:1,instance_guid:'11111111-1111-4111-8111-111111111111',applications:ids.map(app_id=>({app_id,owner:'lab',environment:'dev',source:{repository:'example/fixture',source_path:'apps/'+app_id},postgres:{profile:'shared-dev',database:'cap_lab_dev_'+app_id.replaceAll('-','_'),schema:app_id.replaceAll('-','_'),connection_pool_max:5},credential_namespaces:{runtime:'cap-lab-dev-'+app_id+'-runtime',deployer:'cap-lab-dev-'+app_id+'-deployer'},deletion_policy:'retain'}))})
class MemoryStore {
  constructor(){this.items=new Map()}
  async read(ns){return structuredClone(this.items.get(ns)||null)}
  async create(ns,value){assert(!this.items.has(ns));this.items.set(ns,structuredClone(value))}
  async update(ns,value){assert(this.items.has(ns));this.items.set(ns,structuredClone(value))}
  connection(app,role){return JSON.parse(Buffer.from(this.items.get(app.credential_namespaces[role]).value,'base64').toString())}
}
before(async()=>{
 root=pgClient(config);await root.connect()
 await root.query(`CREATE ROLE catalog_test_admin LOGIN PASSWORD '${scram(config.password)}' CREATEDB CREATEROLE NOSUPERUSER`)
 await root.query('CREATE DATABASE catalog_test_metadata OWNER catalog_test_admin')
})
after(async()=>{await root.end()})
test('real PostgreSQL: two apps, CRUD, isolation, stable replay and retain',async()=>{
 const plan=planFor('requests','assets'),store=new MemoryStore()
 await apply({plan,admin,store})
 const passwords=[...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password)
 await apply({plan,admin,store})
 assert.deepEqual([...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password),passwords)
 const app=plan.applications[0]
 await using(pgClient,store.connection(app,'deployer'),async db=>db.query(`CREATE TABLE ${qi(app.postgres.schema)}.business_data (id integer)`))
 await apply({plan,admin,store})
 await using(pgClient,store.connection(app,'runtime'),async db=>{
  await db.query(`INSERT INTO ${qi(app.postgres.schema)}.business_data VALUES (7)`)
  assert.equal((await db.query(`SELECT id FROM ${qi(app.postgres.schema)}.business_data`)).rows[0].id,7)
 })
 const retained=plan.applications[1]
 await apply({plan:{...plan,applications:[app]},admin,store})
 await using(pgClient,store.connection(retained,'runtime'),async db=>assert.equal((await db.query('SELECT 1 AS n')).rows[0].n,1))
})
for(const stage of ['credentials_prepared','roles_ready','database_created','schema_ready','deployer_published','runtime_published']) {
 test('resume after interruption: '+stage,async()=>{
  const plan=planFor('resume-'+stage.replaceAll('_','-')),store=new MemoryStore()
  await assert.rejects(apply({plan,admin,store,checkpoint:async current=>{if(current===stage)throw Error('simulated interruption')}}),/simulated interruption/)
  const passwords=[...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password)
  await apply({plan,admin,store})
  assert.deepEqual([...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password),passwords)
 })
}
test('refuse unmanaged SQL role without adopting or replacing password',async()=>{
 const plan=planFor('unmanaged'),store=new MemoryStore()
 const role=identity(plan.applications[0],plan.instance_guid).runtime
 await root.query(`CREATE ROLE ${qi(role)} LOGIN`)
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='UNMANAGED_SQL_RESOURCE')
 assert.equal(store.items.size,0)
})
test('refuse unmanaged database even if its name matches',async()=>{
 const plan=planFor('unmanaged-db'),store=new MemoryStore()
 await root.query(`CREATE DATABASE ${qi(plan.applications[0].postgres.database)}`)
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='UNMANAGED_SQL_RESOURCE')
 assert.equal(store.items.size,0)
})
test('do not regenerate lost credentials for an existing allocation',async()=>{
 const plan=planFor('missing-secret'),store=new MemoryStore()
 await apply({plan,admin,store})
 store.items.delete(plan.applications[0].credential_namespaces.runtime)
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='OWNED_CREDENTIAL_MISSING')
 assert.equal(await store.read(plan.applications[0].credential_namespaces.runtime),null)
})
test('reject unsafe privilege drift instead of adopting elevated users',async()=>{
 const plan=planFor('privilege-drift'),store=new MemoryStore()
 await apply({plan,admin,store})
 await root.query(`ALTER ROLE ${qi(identity(plan.applications[0],plan.instance_guid).runtime)} CREATEDB`)
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='ROLE_OWNERSHIP_OR_PRIVILEGE_DRIFT')
})
test('reject database ownership drift',async()=>{
 const plan=planFor('owner-drift'),store=new MemoryStore()
 await apply({plan,admin,store})
 await root.query(`ALTER DATABASE ${qi(plan.applications[0].postgres.database)} OWNER TO catalog_test_root`)
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='DATABASE_OWNER_OR_IDENTITY_MISMATCH')
})
test('server advisory lock refuses another provisioner without creating secrets',async()=>{
 const plan=planFor('concurrent'),store=new MemoryStore()
 await using(pgClient,admin,async lock=>{
  await lock.query('SELECT pg_advisory_lock(741029382)')
  try {await assert.rejects(apply({plan,admin,store}),e=>e.code==='PROVISIONER_ALREADY_RUNNING')}
  finally {await lock.query('SELECT pg_advisory_unlock(741029382)')}
 })
 assert.equal(store.items.size,0)
})
test('reject instance or source identity change',async()=>{
 const plan=planFor('identity-drift'),store=new MemoryStore()
 await apply({plan,admin,store})
 plan.instance_guid='22222222-2222-4222-8222-222222222222'
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='ALLOCATION_IDENTITY_MISMATCH')
})
test('partial SQL role creation rolls back atomically and resumes with the stored passwords',async()=>{
 const plan=planFor('rollback'),store=new MemoryStore()
 const connect=c=>{
  const client=pgClient(c),query=client.query.bind(client)
  client.query=async(...args)=>{
   if(args[0].startsWith('CREATE ROLE "cap_lab_dev_rollback_runtime"')) throw Object.assign(Error('simulated SQL failure'),{code:'XX000'})
   return query(...args)
  }
  return client
 }
 await assert.rejects(apply({plan,admin,store,connect}),e=>e.code==='XX000')
 assert.equal((await root.query("SELECT 1 FROM pg_roles WHERE rolname IN ('cap_lab_dev_rollback_runtime','cap_lab_dev_rollback_deployer')")).rowCount,0)
 const saved=[...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password)
 await apply({plan,admin,store})
 assert.deepEqual([...store.items.values()].map(i=>JSON.parse(Buffer.from(i.value,'base64')).password),saved)
})
test('resume removes only a marked stale permission probe',async()=>{
 const plan=planFor('stale-probe'),store=new MemoryStore(),app=plan.applications[0]
 await apply({plan,admin,store})
 await using(pgClient,store.connection(app,'deployer'),async db=>{
  await db.query(`CREATE TABLE ${qi(app.postgres.schema)}.__catalog_permission_probe (id integer)`)
  await db.query(`COMMENT ON TABLE ${qi(app.postgres.schema)}.__catalog_permission_probe IS 'cap_catalog.permission_probe.v1'`)
 })
 await apply({plan,admin,store})
 await using(pgClient,store.connection(app,'deployer'),async db=>assert.equal((await db.query('SELECT to_regclass($1) AS probe',[app.postgres.schema+'.__catalog_permission_probe'])).rows[0].probe,null))
})
test('an unmarked table with the probe name is retained and reported as a conflict',async()=>{
 const plan=planFor('probe-conflict'),store=new MemoryStore(),app=plan.applications[0]
 await apply({plan,admin,store})
 await using(pgClient,store.connection(app,'deployer'),async db=>{
  await db.query(`CREATE TABLE ${qi(app.postgres.schema)}.__catalog_permission_probe (id integer)`)
  await db.query(`INSERT INTO ${qi(app.postgres.schema)}.__catalog_permission_probe VALUES (77)`)
 })
 await assert.rejects(apply({plan,admin,store}),e=>e.code==='PROBE_RESOURCE_CONFLICT')
 await using(pgClient,store.connection(app,'runtime'),async db=>assert.equal((await db.query(`SELECT id FROM ${qi(app.postgres.schema)}.__catalog_permission_probe`)).rows[0].id,77))
})
