import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.env.MAPI_NEXTGEN_SOURCE) throw Error('Set MAPI_NEXTGEN_SOURCE to the isolated pinned Nextgen checkout');
const api=resolve(process.env.MAPI_NEXTGEN_SOURCE,'apps/api');
const dir=await mkdtemp(resolve(api,'mapi-csp-check-'));
try {
  await writeFile(resolve(dir,'main.go'),`package main\nimport("encoding/json";"fmt";"os";"github.com/zitadel/nextgen/internal/staticui/console")\nfunc main(){b,e:=os.ReadFile(os.Args[1]);if e!=nil{panic(e)};x,y:=console.Policies(string(b));v,_:=json.Marshal(map[string]string{"enforced":x,"report":y});fmt.Print(string(v))}\n`);
  const out=execFileSync('go',['run',resolve(dir,'main.go'),resolve('worker/generated/console-assets/index.html')],{cwd:api,env:{...process.env,GOWORK:'off',GOTOOLCHAIN:'go1.26.9'},encoding:'utf8'});
  assert.deepEqual(JSON.parse(out),JSON.parse(await readFile('worker/generated/console-policy.json','utf8')));
  console.log('Built index CSP exactly matches pinned upstream Go policy.');
} finally {await rm(dir,{recursive:true,force:true});}
