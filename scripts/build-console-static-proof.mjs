import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source=process.env.MAPI_CONSOLE_DIST;
if (!source) throw Error('Set MAPI_CONSOLE_DIST to the pinned Console build output');
const dist=resolve(source), index=await readFile(resolve(dist,'index.html'),'utf8');
if (!index.includes('/ui/console/')) throw Error('Console must be built for /ui/console/');
const hashes=[];
for (const match of index.matchAll(/<script\b([^>]*)>(.*?)<\/script\s*>/gis)) {
  if (!/(^|\s)src\s*=/i.test(match[1])) hashes.push("'sha256-"+createHash('sha256').update(match[2]).digest('base64')+"'");
}
const scripts=["script-src 'self'",...hashes].join(' ');
const enforced=[scripts,"object-src 'none'","base-uri 'self'","frame-ancestors 'none'",'report-uri /csp-report'].join('; ');
const report=["default-src 'self'",scripts,"style-src 'self' 'unsafe-inline'","img-src 'self' data: https:","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'none'",'report-uri /csp-report'].join('; ');
const target=resolve('worker/generated/console-assets');await rm(target,{recursive:true,force:true});await mkdir(target,{recursive:true});await cp(dist,target,{recursive:true});
await writeFile('worker/generated/console-policy.json',JSON.stringify({enforced,report})+'\n');
console.log(`Prepared pinned Console static proof; index ${(await stat(resolve(dist,'index.html'))).size} bytes, ${hashes.length} inline script hashes.`);
