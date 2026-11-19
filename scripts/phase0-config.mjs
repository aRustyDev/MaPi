import { writeFile } from 'node:fs/promises';
const { MAPI_PHASE0_ACCOUNT: account_id, MAPI_PHASE0_NAME: name, MAPI_PHASE0_SUBDOMAIN: subdomain } = process.env;
if (!account_id || !/^[0-9a-f]{32}$/.test(account_id) || !name || !/^mapi-phase0-[a-z0-9-]+$/.test(name) || !subdomain || !/^[a-z0-9-]+$/.test(subdomain)) throw Error('Set account ID, a new mapi-phase0-* Worker name, and workers.dev subdomain. Verify the name is unused before deploying.');
const config = {account_id,name,main:'worker/app.js',compatibility_date:'2026-11-18',workers_dev:true,preview_urls:false,observability:{enabled:true},durable_objects:{bindings:[{name:'NEXTGEN_APPLICATION',class_name:'NextgenApplication'},{name:'PROJECT_REGISTRY',class_name:'ProjectRegistry'}]},migrations:[{tag:'v1',new_sqlite_classes:['NextgenApplication']},{tag:'v2',new_sqlite_classes:['ProjectRegistry']}],vars:{MAPI_APP_ORIGIN:`https://${name}.${subdomain}.workers.dev`,MAPI_SCHEMA_TARGET:'2'}};
await writeFile('wrangler.phase0-app.json',JSON.stringify(config,null,2)+'\n',{flag:'wx'});
console.log(`Created isolated config for ${name}. Verify it is unused before deployment.`);
const pocName = process.env.MAPI_PHASE0_POC_NAME;
if (pocName) {
  if (!/^mapi-phase0-[a-z0-9-]+$/.test(pocName) || pocName === name) throw Error('MAPI_PHASE0_POC_NAME must be a different new mapi-phase0-* Worker name.');
  const poc = { account_id, name:pocName, main:'worker/index.js',compatibility_date:'2026-11-18',workers_dev:true,preview_urls:false,observability:{enabled:true},durable_objects:{bindings:[{name:'NEXTGEN_PROJECT',class_name:'NextgenProject'}]},migrations:[{tag:'v1',new_sqlite_classes:['NextgenProject']}] };
  await writeFile('wrangler.phase0-poc.json',JSON.stringify(poc,null,2)+'\n',{flag:'wx'});
  console.log(`Created isolated fixture config for ${pocName}. Verify it is unused before deployment.`);
}
