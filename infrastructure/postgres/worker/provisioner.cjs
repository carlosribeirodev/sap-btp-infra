const crypto = require('node:crypto')
const { Client } = require('pg')
class ProvisionError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new ProvisionError(code) }
const qi = value => '"' + value.replaceAll('"', '""') + '"'
const ql = value => "'" + value.replaceAll("'", "''") + "'"
const keyOf = app => `${app.environment}/${app.app_id}`
const roleName = (app, role) => `${app.postgres.database}_${role}`
function validatePlan(plan) {
  if (plan.api_version !== 1 || !/^[a-f0-9-]{36}$/i.test(plan.instance_guid || '') || !Array.isArray(plan.applications) || !plan.applications.length) fail('INVALID_PLAN')
  const seen = new Set()
  for (const app of plan.applications) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(app.app_id || '') || !/^[a-z][a-z0-9-]{0,30}$/.test(app.owner || '') || app.environment !== 'dev' || app.deletion_policy !== 'retain' || seen.has(keyOf(app))) fail('INVALID_PLAN')
    seen.add(keyOf(app))
    const sql = app.app_id.replaceAll('-', '_')
    if (app.postgres?.database !== `cap_lab_dev_${sql}` || app.postgres.schema !== sql || app.postgres.profile !== 'shared-dev' || !Number.isInteger(app.postgres.connection_pool_max) || app.postgres.connection_pool_max < 1 || app.postgres.connection_pool_max > 5) fail('INVALID_PLAN')
    for (const role of ['deployer', 'runtime']) if (app.credential_namespaces?.[role] !== `cap-lab-dev-${app.app_id}-${role}`) fail('INVALID_PLAN')
    if (!app.source?.repository || !app.source.source_path) fail('INVALID_PLAN')
  }
}
function identity(app, instance) {
  return { key: keyOf(app), owner: app.owner, instance_guid: instance, database: app.postgres.database, schema: app.postgres.schema,
    deployer: roleName(app, 'deployer'), runtime: roleName(app, 'runtime'), source: app.source }
}
function scram(password) {
  const salt = crypto.randomBytes(16)
  const salted = crypto.pbkdf2Sync(password, salt, 4096, 32, 'sha256')
  const client = crypto.createHmac('sha256', salted).update('Client Key').digest()
  const stored = crypto.createHash('sha256').update(client).digest('base64')
  const server = crypto.createHmac('sha256', salted).update('Server Key').digest('base64')
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`
}
function pgClient(config) {
  return new Client({ ...config, connectionTimeoutMillis: 10000, query_timeout: 20000, application_name: 'cap-catalog-provisioner' })
}
async function using(connect, config, callback) {
  const client = connect(config)
  try { await client.connect(); return await callback(client) }
  finally { await client.end().catch(() => {}) }
}
function decode(item, expected, base) {
  let record
  try { record = JSON.parse(Buffer.from(item.value, 'base64').toString()) } catch { fail('INVALID_STORED_CREDENTIAL') }
  if (JSON.stringify(record.allocation) !== JSON.stringify(expected) || !['prepared','ready'].includes(record.phase) || record.host !== base.host || Number(record.port) !== base.port || JSON.stringify(record.ssl) !== JSON.stringify(base.ssl) || record.database !== expected.database || record.schema !== expected.schema || ![expected.deployer, expected.runtime].includes(record.user) || !/^[a-f0-9]{64}$/.test(record.password || '')) fail('CREDENTIAL_TARGET_MISMATCH')
  return record
}
const encode = record => ({name:'postgres', username:record.user, format:'json', value:Buffer.from(JSON.stringify(record)).toString('base64')})

async function initialize(db) {
  const owner = await db.query("SELECT pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname='cap_catalog'")
  if (owner.rowCount && !owner.rows[0].owned) fail('METADATA_OWNER_MISMATCH')
  await db.query('CREATE SCHEMA IF NOT EXISTS cap_catalog')
  await db.query('REVOKE ALL ON SCHEMA cap_catalog FROM PUBLIC')
  await db.query(`CREATE TABLE IF NOT EXISTS cap_catalog.allocations (
    key text PRIMARY KEY, identity jsonb NOT NULL, phase text NOT NULL,
    role_oids jsonb, database_oid oid, updated_at timestamptz NOT NULL DEFAULT now())`)
  const table = await db.query("SELECT pg_get_userbyid(relowner)=current_user AS owned FROM pg_class WHERE oid='cap_catalog.allocations'::regclass")
  if (!table.rows[0].owned) fail('METADATA_OWNER_MISMATCH')
  await db.query('REVOKE ALL ON cap_catalog.allocations FROM PUBLIC')
}
async function roleRows(db, names) {
  return (await db.query(`SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])).rows
}
async function assertRoles(db, names, oids) {
  const rows = await roleRows(db, names)
  if (rows.length !== 2 || rows.some(r => Number(r.oid) !== Number(oids[r.rolname]) || !r.rolcanlogin || r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolreplication || r.rolbypassrls)) fail('ROLE_OWNERSHIP_OR_PRIVILEGE_DRIFT')
  const membership = await db.query('SELECT 1 FROM pg_auth_members WHERE member=ANY($1::oid[]) LIMIT 1', [rows.map(r => r.oid)])
  if (membership.rowCount) fail('UNEXPECTED_ROLE_MEMBERSHIP')
}
async function setPhase(db, key, phase) {
  await db.query('UPDATE cap_catalog.allocations SET phase=$2,updated_at=now() WHERE key=$1', [key, phase])
}
async function assertAcl(db, query, args, allowed) {
  const rows = (await db.query(query, args)).rows
  if (rows.some(r => !allowed.includes(r.name))) fail('UNEXPECTED_ACCESS_GRANT')
}
async function configureSchema(connect, deployer, id) {
  await using(connect, deployer, async owner => {
    await owner.query('BEGIN')
    try {
      await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
      const schema = await owner.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1', [id.schema])
      if (schema.rowCount && schema.rows[0].owner !== id.deployer) fail('SCHEMA_OWNER_MISMATCH')
      await owner.query(`CREATE SCHEMA IF NOT EXISTS ${qi(id.schema)} AUTHORIZATION ${qi(id.deployer)}`)
      await assertAcl(owner, `SELECT pg_get_userbyid(a.grantee) AS name FROM pg_namespace n,
        LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=$1`, [id.schema], [id.deployer,id.runtime])
      await owner.query(`REVOKE ALL ON SCHEMA ${qi(id.schema)} FROM PUBLIC, ${qi(id.runtime)}`)
      await owner.query(`GRANT USAGE ON SCHEMA ${qi(id.schema)} TO ${qi(id.runtime)}`)
      await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${qi(id.schema)} TO ${qi(id.runtime)}`)
      await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${qi(id.schema)} TO ${qi(id.runtime)}`)
      await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(id.deployer)} IN SCHEMA ${qi(id.schema)} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${qi(id.runtime)}`)
      await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(id.deployer)} IN SCHEMA ${qi(id.schema)} GRANT USAGE,SELECT ON SEQUENCES TO ${qi(id.runtime)}`)
      await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(id.deployer)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`)
      await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(id.deployer)} IN SCHEMA ${qi(id.schema)} GRANT EXECUTE ON FUNCTIONS TO ${qi(id.runtime)}`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  })
}
async function verifyRuntime(connect, connection, otherDatabases = []) {
  await using(connect, connection, async db => {
    const flags = await db.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      has_schema_privilege(current_user,$1,'CREATE') AS schema_create FROM pg_roles WHERE rolname=current_user`, [connection.schema])
    if (Object.values(flags.rows[0]).some(Boolean)) fail('RUNTIME_HAS_EXCESS_PRIVILEGES')
    const owned = await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1`, [connection.schema])
    if (owned.rowCount) fail('RUNTIME_OWNS_PERSISTENT_OBJECTS')
    await db.query('BEGIN')
    try {
      let denied = false
      try { await db.query(`CREATE TABLE ${qi(connection.schema)}.${qi('__catalog_denied_' + crypto.randomBytes(5).toString('hex'))} (id integer)`) }
      catch (error) { if (error.code !== '42501') throw error; denied = true }
      if (!denied) fail('RUNTIME_DDL_NOT_DENIED')
    } finally { await db.query('ROLLBACK') }
    if ((await db.query('SELECT current_schema() AS schema')).rows[0].schema !== connection.schema) fail('RUNTIME_SEARCH_PATH_MISMATCH')
  })
  for (const database of otherDatabases) {
    let denied = false
    try { await using(connect, {...connection, database}, async () => {}) }
    catch (error) { if (error.code !== '42501') throw error; denied = true }
    if (!denied) fail('CROSS_DATABASE_NOT_DENIED')
  }
}
async function probe(connect, deployer, runtime, id) {
  await using(connect, deployer, async owner => {
    const table = `${qi(id.schema)}."__catalog_permission_probe"`
    const existing = await owner.query(`SELECT pg_get_userbyid(c.relowner) AS owner,obj_description(c.oid,'pg_class') AS marker
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='__catalog_permission_probe'`, [id.schema])
    if (existing.rowCount) {
      if (existing.rows[0].owner!==id.deployer || existing.rows[0].marker!=='cap_catalog.permission_probe.v1') fail('PROBE_RESOURCE_CONFLICT')
      await owner.query(`DROP TABLE ${table}`)
    }
    // Create the probe and its ownership marker atomically. A killed task can resume.
    await owner.query('BEGIN')
    try {
      await owner.query(`CREATE TABLE ${table} (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, value text)`)
      await owner.query(`COMMENT ON TABLE ${table} IS 'cap_catalog.permission_probe.v1'`)
      await owner.query('COMMIT')
    } catch(error) { await owner.query('ROLLBACK'); throw error }
    try {
      await using(connect, runtime, async db => {
        await db.query('BEGIN')
        try {
          const inserted = await db.query(`INSERT INTO ${table}(value) VALUES ($1) RETURNING id`, ['probe'])
          const row = inserted.rows[0].id
          await db.query(`UPDATE ${table} SET value=$1 WHERE id=$2`, ['updated', row])
          if ((await db.query(`SELECT value FROM ${table} WHERE id=$1`, [row])).rows[0]?.value !== 'updated') fail('CRUD_PROBE_FAILED')
          if ((await db.query(`DELETE FROM ${table} WHERE id=$1`, [row])).rowCount !== 1) fail('CRUD_PROBE_FAILED')
        } finally { await db.query('ROLLBACK') }
      })
    } finally { await owner.query(`DROP TABLE ${table}`) }
  })
}

async function apply({plan, admin, store, connect=pgClient, checkpoint=async()=>{}, emit=()=>{}}) {
  validatePlan(plan)
  const base = {host:admin.host,port:Number(admin.port),ssl:admin.ssl}
  return using(connect, admin, async db => {
    if (Number((await db.query('SHOW server_version_num')).rows[0].server_version_num) < 160000) fail('POSTGRESQL_16_REQUIRED')
    if (!(await db.query('SELECT pg_try_advisory_lock(741029382) AS locked')).rows[0].locked) fail('PROVISIONER_ALREADY_RUNNING')
    try {
      await initialize(db)
      for (const app of plan.applications) {
        const id = identity(app, plan.instance_guid), names = [id.deployer,id.runtime]
        let state = (await db.query('SELECT * FROM cap_catalog.allocations WHERE key=$1', [id.key])).rows[0]
        if (!state) {
          if ((await roleRows(db,names)).length || (await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[id.database])).rowCount) fail('UNMANAGED_SQL_RESOURCE')
          for (const role of ['deployer','runtime']) if (await store.read(app.credential_namespaces[role])) fail('UNMANAGED_STORED_CREDENTIAL')
          await db.query("INSERT INTO cap_catalog.allocations(key,identity,phase) VALUES ($1,$2,'reserved')", [id.key,id])
          state = {identity:id,phase:'reserved'}
        }
        // jsonb key order differs from JSON serialization; compare canonical fields.
        if (crypto.createHash('sha256').update(canonical(state.identity)).digest('hex') !== crypto.createHash('sha256').update(canonical(id)).digest('hex')) fail('ALLOCATION_IDENTITY_MISMATCH')
        if (!['reserved','roles_ready','database_ready','ready'].includes(state.phase)) fail('INVALID_ALLOCATION_STATE')
        const credentials = {}
        for (const role of ['deployer','runtime']) {
          const namespace = app.credential_namespaces[role], item = await store.read(namespace)
          if (item) credentials[role] = decode(item,id,base)
          else {
            if (state.phase !== 'reserved') fail('OWNED_CREDENTIAL_MISSING')
            credentials[role] = {...base,database:id.database,schema:id.schema,user:id[role],password:crypto.randomBytes(32).toString('hex'),phase:'prepared',allocation:id}
            await store.create(namespace,encode(credentials[role]))
          }
          if (credentials[role].user !== id[role]) fail('CREDENTIAL_TARGET_MISMATCH')
        }
        await checkpoint('credentials_prepared', app)
        if (state.phase === 'reserved') {
          await db.query('BEGIN')
          try {
            if ((await roleRows(db,names)).length) fail('UNMANAGED_SQL_RESOURCE')
            for (const role of ['deployer','runtime']) await db.query(`CREATE ROLE ${qi(id[role])} LOGIN PASSWORD ${ql(scram(credentials[role].password))} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`)
            state.role_oids = Object.fromEntries((await roleRows(db,names)).map(r=>[r.rolname,r.oid]))
            await db.query("UPDATE cap_catalog.allocations SET phase='roles_ready',role_oids=$2,updated_at=now() WHERE key=$1",[id.key,state.role_oids])
            await db.query('COMMIT')
            state.phase = 'roles_ready'
          } catch (error) { await db.query('ROLLBACK'); throw error }
        }
        await assertRoles(db,names,state.role_oids)
        await checkpoint('roles_ready',app)
        await db.query(`GRANT ${qi(id.deployer)} TO CURRENT_USER WITH SET TRUE, INHERIT TRUE`)
        let database = (await db.query('SELECT oid,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[id.database])).rows[0]
        if (!database) {
          if (state.phase !== 'roles_ready') fail('OWNED_DATABASE_MISSING')
          await db.query(`CREATE DATABASE ${qi(id.database)} OWNER ${qi(id.deployer)} TEMPLATE template0 ALLOW_CONNECTIONS false`)
          await checkpoint('database_created',app)
          database = (await db.query('SELECT oid,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[id.database])).rows[0]
        }
        if (database.owner !== id.deployer || (state.database_oid && Number(state.database_oid) !== Number(database.oid))) fail('DATABASE_OWNER_OR_IDENTITY_MISMATCH')
        await assertAcl(db,`SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS name FROM pg_database d,
          LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=$1`,[id.database],['PUBLIC',...names])
        await db.query(`SET ROLE ${qi(id.deployer)}`)
        try {
          await db.query(`REVOKE ALL ON DATABASE ${qi(id.database)} FROM PUBLIC, ${qi(id.runtime)}`)
          await db.query(`GRANT CONNECT,TEMPORARY ON DATABASE ${qi(id.database)} TO ${qi(id.runtime)}, ${qi(id.deployer)}`)
          await db.query(`ALTER DATABASE ${qi(id.database)} ALLOW_CONNECTIONS true`)
        } finally { await db.query('RESET ROLE') }
        for (const role of names) await db.query(`ALTER ROLE ${qi(role)} IN DATABASE ${qi(id.database)} SET search_path TO ${qi(id.schema)},pg_catalog,pg_temp`)
        await db.query("UPDATE cap_catalog.allocations SET database_oid=$2,phase='database_ready',updated_at=now() WHERE key=$1",[id.key,database.oid])
        await configureSchema(connect,credentials.deployer,id)
        await checkpoint('schema_ready',app)
        await probe(connect,credentials.deployer,credentials.runtime,id)
        await verifyRuntime(connect,credentials.runtime)
        for (const role of ['deployer','runtime']) {
          credentials[role].phase = 'ready'
          await store.update(app.credential_namespaces[role],encode(credentials[role]))
          await checkpoint(role+'_published',app)
        }
        await setPhase(db,id.key,'ready')
        emit({app_id:app.app_id,environment:app.environment,phase:'ready',credentialsInStore:true,crudVerified:true,runtimeDdlDenied:true})
      }
      // Cross-database denial is checked only after every declared database exists.
      for (const app of plan.applications) {
        const id=identity(app,plan.instance_guid)
        const c=decode(await store.read(app.credential_namespaces.runtime),id,base)
        await verifyRuntime(connect,c,plan.applications.filter(a=>keyOf(a)!==id.key).map(a=>a.postgres.database))
      }
    } finally { await db.query('SELECT pg_advisory_unlock(741029382)').catch(()=>{}) }
  })
}
function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']'
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
  return JSON.stringify(value)
}
module.exports = { apply, validatePlan, verifyRuntime, pgClient, identity, decode, ProvisionError, using, qi, canonical, scram }
