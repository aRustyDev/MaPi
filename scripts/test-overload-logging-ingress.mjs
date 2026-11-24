// Synthetic ingress failure only: no hosted Worker or external service.
import assert from 'node:assert/strict';
import { handleManagementApp } from '../worker/management-ingress.js';

const request=new Request('https://project.example/api/v1/users/user_test');
const fallback={fetch(){throw Error('Unexpected fallback');}};
const original=console.error;
try {
  console.error=()=>{throw Error('Synthetic log sink failure');};
  const overload=Object.assign(new Error('private synthetic detail'),{overloaded:true});
  const env={MAPI_MANAGEMENT_ENABLED:'1',PROJECT_REGISTRY:{getByName(){throw overload;}}};
  const response=await handleManagementApp(request,env,fallback);
  assert.equal(response.status,503);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(await response.text(),'');
  const throwingGetter=new Error('private synthetic detail');
  Object.defineProperty(throwingGetter,'overloaded',{get(){throw Error('Synthetic classification failure');}});
  env.PROJECT_REGISTRY.getByName=()=>{throw throwingGetter;};
  assert.equal((await handleManagementApp(request,env,fallback)).status,503);
} finally {console.error=original;}
console.log('Management ingress retains 503 when overload logging fails');
