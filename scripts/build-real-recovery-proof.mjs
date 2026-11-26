import { readFile, writeFile } from 'node:fs/promises';

// Create an ignored test object from the real app without modifying its ingress.
let app = await readFile('worker/app.js', 'utf8');
app = app.replace('"./generated/baseline.json"', '"./baseline.json"')
  .replace('"./wasm-module.js"', '"./phase1-owner.wasm"')
  .replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
const member = '  #wasmDiagnostic = "";';
const transaction = '              if (this.#reactor.mapi_transaction_body() !== 0) throw rejected;';
const hook = '  handleRequest(request) {';
if (!app.includes(member) || !app.includes(transaction) || !app.includes(hook)) throw Error('Application test anchors changed');
app = app.replace(member, `${member}\n  #proofRoute;\n  #proofPending = new Map();\n  #proofChecks = 0;`);
app = app.replace(transaction, `              if (this.#proofRoute) { this.#proofAssert(this.#proofRoute); this.#proofChecks++; }\n${transaction}`);
app = app.replace(hook, `
  #proofAssert(route) {
    const owner = this.ctx.storage.sql.exec('SELECT * FROM mapi_proof_owner').toArray()[0];
    if (this.env.MAPI_LOCAL_TEST !== '1' || !owner || owner.project_id !== route.projectId || owner.era !== route.era || owner.state !== 'active' || this.projectId() !== route.projectId) throw Error('owner fenced');
  }
  async #proofRegistry(route, state = 'active') {
    const current = await this.env.RECOVERY_REGISTRY.getByName('control').read(route.projectId);
    if (!current || current.era !== route.era || current.state !== state) throw Error('registry fenced');
  }
  proofInit(era) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || !this.projectId()) throw Error('test only');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mapi_proof_owner (project_id TEXT PRIMARY KEY, era TEXT NOT NULL, state TEXT NOT NULL)');
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO mapi_proof_owner VALUES (?, ?, 'active')", this.projectId(), era);
  }
  async proofCall(route, operation, value = {}) {
    await this.#proofRegistry(route);
    this.#proofAssert(route);
    this.#proofRoute = route;
    try {
      if (operation === 'add') return this.addUser(value.email, value.password, route.ownerRoute);
      if (operation === 'login') return this.login(value.email, value.password, value.ip ?? '127.0.0.1', route.ownerRoute);
      if (operation === 'mint') return this.#withRoute(route.ownerRoute, () => this.#mintHandoff(value.email, value.password));
      if (operation === 'exchange') return this.#withRoute(route.ownerRoute, () => { this.#initialize(); return this.#exchangeHandoff(value.handoff); });
      if (operation === 'session') return this.session(value.cookie, value.action ?? 'read', value.csrf ?? '', route.ownerRoute);
      throw Error('unsupported operation');
    } finally { this.#proofRoute = undefined; }
  }
  async proofDelayedAdd(route, id, email, password) {
    await this.#proofRegistry(route); this.#proofAssert(route);
    await new Promise(resolve => this.#proofPending.set(id, resolve));
    return this.proofCall(route, 'add', {email,password});
  }
  proofWaiting(id) { return this.#proofPending.has(id); }
  proofRelease(id) { const fn=this.#proofPending.get(id); if(!fn)throw Error('unknown job'); this.#proofPending.delete(id); fn(); }
  proofFreeze(route) {
    this.ctx.storage.transactionSync(() => { this.#proofAssert(route); this.ctx.storage.sql.exec("UPDATE mapi_proof_owner SET state='frozen'"); });
  }
  proofBackup(route) {
    this.#proofAssert(route);
    this.ctx.storage.transactionSync(() => {
      const sql=this.ctx.storage.sql;
      for (const table of ['sessions','tokens','auth_attempts','checks']) {
        sql.exec('DROP TABLE IF EXISTS mapi_proof_backup_'+table);
        sql.exec('CREATE TABLE mapi_proof_backup_'+table+' AS SELECT * FROM '+table+' WHERE project_id=?', route.projectId);
      }
    });
  }
  // A partial simulation only: restores relevant rows, not the full database or a PITR bookmark.
  proofRestore(route) {
    const sql=this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      if(sql.exec('SELECT state FROM mapi_proof_owner').one().state !== 'frozen')throw Error('restore without freeze');
      sql.exec('DELETE FROM checks WHERE project_id=?',route.projectId);
      sql.exec('DELETE FROM sessions WHERE project_id=?',route.projectId);
      sql.exec("DELETE FROM tokens WHERE project_id=? AND token_type='session_token'",route.projectId);
      sql.exec('DELETE FROM auth_attempts WHERE project_id=?',route.projectId);
      sql.exec('INSERT INTO sessions (project_id,id,created_at,updated_at,time_to_live,token_id,user_id,user_agent_id) SELECT project_id,id,created_at,updated_at,time_to_live,token_id,user_id,user_agent_id FROM mapi_proof_backup_sessions');
      sql.exec("INSERT INTO tokens SELECT * FROM mapi_proof_backup_tokens WHERE token_type='session_token'");
      sql.exec('INSERT INTO auth_attempts SELECT * FROM mapi_proof_backup_auth_attempts');
      sql.exec('INSERT INTO checks SELECT * FROM mapi_proof_backup_checks');
      sql.exec("UPDATE mapi_recovery_epoch SET epoch='0'");
      sql.exec("UPDATE mapi_proof_owner SET era=?, state='active'",route.era);
    });
  }
  async proofRecover(route, fail = false, crashAfterCommit = false) {
    await this.#proofRegistry(route, 'recovering');
    if (this.projectId() !== route.projectId) throw Error('wrong owner');
    const sql=this.ctx.storage.sql;
    if(sql.exec('SELECT epoch FROM mapi_recovery_epoch').one().epoch !== route.era) {
      if(fail)this.#failAudit=1;
      this.#withRoute(route.ownerRoute, () => { this.#initialize(); this.#call('mapi_recover',{projectId:route.projectId,epoch:route.era}); });
      if(crashAfterCommit){await this.ctx.storage.sync();this.ctx.abort('test recovery checkpoint');}
    }
    this.ctx.storage.transactionSync(() => {
      if(sql.exec('SELECT epoch FROM mapi_recovery_epoch').one().epoch !== route.era)throw Error('recovery not committed');
      sql.exec("UPDATE mapi_proof_owner SET era=?, state='active' WHERE project_id=?",route.era,route.projectId);
    });
  }
  proofState() {
    const sql=this.ctx.storage.sql,p=this.projectId();
    return { owner:sql.exec('SELECT * FROM mapi_proof_owner').one(), epoch:sql.exec('SELECT epoch FROM mapi_recovery_epoch').one().epoch,
      users:sql.exec('SELECT count(*) AS n FROM users WHERE project_id=?',p).one().n,
      sessions:sql.exec('SELECT count(*) AS n FROM sessions WHERE project_id=?',p).one().n,
      recovered:sql.exec("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='mapi.recovery.completed'",p).one().n,
      checks:this.#proofChecks };
  }

${hook}`);
await writeFile('worker/generated/real-recovery-proof-object.js', app);
console.log('Built local-only real project recovery object.');
