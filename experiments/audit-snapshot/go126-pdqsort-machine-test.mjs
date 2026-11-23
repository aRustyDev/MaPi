// Native differential test only. Does not authenticate checkpoints, exercise
// the lifecycle spool, bound comparator internals, or validate a handler.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {newSortMachine,stepSortMachine} from './go126-pdqsort-machine.mjs';
let seed=0x12345678;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const cases=[];
for(const n of [0,1,2,11,12,13,14,24,49,50,51,99,100,127,128,199,256,511,1000]) {
  for(let kind=0;kind<8;kind++) {
    const a=Array.from({length:n},(_,id)=>({id,key:kind===0?id:kind===1?n-id:kind===2?0:kind===3?id%3:kind===4?random()%7:kind===5?random()%100000:kind===6?Math.abs(id-Math.floor(n/2)):random()%2}));
    cases.push(a);
  }
}
for(let i=0;i<300;i++) {const n=random()%300;cases.push(Array.from({length:n},(_,id)=>({id,key:random()%((random()%20)+1)})));}
const toolchain='/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
const oracle=spawnSync(toolchain,['run','experiments/audit-snapshot/go126-sort-oracle.go'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:100*1024*1024,env:{...process.env,GOCACHE:'/private/tmp/mapi-go126-sort-machine-cache',GOPROXY:'off',GOTOOLCHAIN:'go1.26.9'}});
if(oracle.status!==0) throw Error(`Go oracle failed: ${oracle.stderr}`);
const expected=JSON.parse(oracle.stdout);
let maxCheckpoint=0,maxSteps=0,totalSteps=0;const exercised=new Set();
for(let index=0;index<cases.length;index++) {
  const array=cases[index].map(x=>({...x}));let machine=newSortMachine(array.length),steps=0;
  while(!machine.done) {
    for(const frame of machine.frames) exercised.add(frame.op);
    let calls=0;
    const result=stepSortMachine(machine,(i,j)=>{calls++;return array[i].key-array[j].key;});
    assert.ok(calls<=1);
    if(result.swap) {const [a,b]=result.swap;[array[a],array[b]]=[array[b],array[a]];}
    // Serialize and deserialize at every interruption point.
    const encoded=JSON.stringify(result.state);maxCheckpoint=Math.max(maxCheckpoint,Buffer.byteLength(encoded));machine=JSON.parse(encoded);
    if(++steps>Math.max(20000,array.length*1000)) throw Error(`Machine did not terminate for case ${index}`);
  }
  assert.deepEqual(array,expected[index],`case ${index}, length ${array.length}`);
  maxSteps=Math.max(maxSteps,steps);totalSteps+=steps;
}
console.log(JSON.stringify({cases:cases.length,maxCheckpointBytes:maxCheckpoint,maxSteps,totalSteps,exercised:[...exercised].sort()}));
