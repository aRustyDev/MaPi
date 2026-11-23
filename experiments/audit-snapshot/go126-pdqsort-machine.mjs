// Unmounted implementation experiment: Go 1.26.9 slices.SortFunc's pdqsort
// over indexed opaque handles. Each step yields at most one comparison and one
// swap. The caller must atomically persist returned state with the swap, fence
// reads and authority, and independently bound comparison work. The state is
// not authenticated and is not accepted from an untrusted client.
// Algorithm translated from Go's BSD-licensed src/slices/zsortanyfunc.go.
const VERSION='go1.26.9-pdqsort-v1';
const MASK=(1n<<64n)-1n;

export function newSortMachine(n) {
  if(!Number.isSafeInteger(n)||n<0) throw Error('Invalid sort length');
  return {version:VERSION,n,done:false,frames:[{op:'pdq',p:0,a:0,b:n,limit:n?BigInt(n).toString(2).length:0,balanced:true,partitioned:true}]};
}

// Caller supplies a synchronous comparator over current spool positions.
// It must provide the same ordering for the entire protected snapshot.
export function stepSortMachine(input,compare) {
  if(!input || input.version!==VERSION || input.done!==false || !Array.isArray(input.frames) || !input.frames.length || typeof compare!=='function') throw Error('Invalid sort state');
  const s=JSON.parse(JSON.stringify(input));
  let swap=null, compared=false;
  function cmp(i,j) {
    if(compared || !Number.isSafeInteger(i)||!Number.isSafeInteger(j)||i<0||j<0||i>=s.n||j>=s.n) throw Error('Invalid sort comparison');
    const c=compare(i,j); if(typeof c!=='number'||!Number.isFinite(c)) throw Error('Invalid sort comparison result'); compared=true; return c<0;
  }
  function sw(i,j) {
    if(swap || !Number.isSafeInteger(i)||!Number.isSafeInteger(j)||i<0||j<0||i>=s.n||j>=s.n) throw Error('Invalid sort swap');
    if(i!==j) swap=[i,j];
  }
  function call(f,pc,child) { f.p=pc; s.frames.push(child); }
  function ret(value) { s.frames.pop(); if(s.frames.length) s.frames.at(-1).rv=value; else s.done=true; }
  // Pure control transitions are bounded even for malformed trusted input.
  for(let ticks=0;ticks<128 && !s.done && !compared && !swap;ticks++) {
    const f=s.frames.at(-1);
    switch(f.op) {
    case 'pdq': {
      switch(f.p) {
      case 0:
        f.len=f.b-f.a;
        if(f.len<=12) { call(f,99,{op:'insert',p:0,a:f.a,b:f.b,i:f.a+1}); break; }
        if(f.limit===0) { call(f,99,{op:'heap',p:0,a:f.a,b:f.b}); break; }
        if(!f.balanced) { f.limit--; call(f,1,{op:'break',p:0,a:f.a,b:f.b}); break; }
        f.p=1; break;
      case 1: call(f,2,{op:'pivot',p:0,a:f.a,b:f.b}); break;
      case 2:
        f.pivot=f.rv.pivot;f.hint=f.rv.hint;delete f.rv;
        if(f.hint==='decreasing') { call(f,3,{op:'reverse',p:0,i:f.a,j:f.b-1}); break; }
        f.p=4;break;
      case 3: f.pivot=(f.b-1)-(f.pivot-f.a);f.hint='increasing';f.p=4;break;
      case 4:
        if(f.balanced && f.partitioned && f.hint==='increasing') { call(f,5,{op:'partial',p:0,a:f.a,b:f.b,i:f.a+1,steps:0}); break; }
        f.p=6;break;
      case 5: if(f.rv) {ret();break;} delete f.rv;f.p=6;break;
      case 6:
        if(f.a>0) { const less=cmp(f.a-1,f.pivot); f.p=less?8:7;break; }
        f.p=8;break;
      case 7: call(f,10,{op:'partitionEqual',p:0,a:f.a,b:f.b,pivot:f.pivot});break;
      case 8: call(f,9,{op:'partition',p:0,a:f.a,b:f.b,pivot:f.pivot});break;
      case 9: {
        const {mid,already}=f.rv;delete f.rv;f.partitioned=already;
        const left=mid-f.a,right=f.b-mid,threshold=Math.floor(f.len/8);
        if(left<right) { f.balanced=left>=threshold;const child={op:'pdq',p:0,a:f.a,b:mid,limit:f.limit,balanced:true,partitioned:true};f.a=mid+1;call(f,11,child); }
        else { f.balanced=right>=threshold;const child={op:'pdq',p:0,a:mid+1,b:f.b,limit:f.limit,balanced:true,partitioned:true};f.b=mid;call(f,11,child); }
        break;
      }
      case 10: f.a=f.rv;delete f.rv;f.p=0;break;
      case 11: delete f.rv;f.p=0;break;
      case 99: ret();break;
      default: throw Error('Invalid pdq state');
      } break;
    }
    case 'insert':
      switch(f.p) {
      case 0: if(f.i>=f.b){ret();break;} f.j=f.i;f.p=1;break;
      case 1: if(f.j<=f.a){f.i++;f.p=0;break;} if(cmp(f.j,f.j-1)){sw(f.j,f.j-1);f.j--;}else{f.i++;f.p=0;}break;
      default:throw Error('Invalid insertion state');
      } break;
    case 'reverse':
      if(f.i>=f.j){ret();break;} sw(f.i,f.j);f.i++;f.j--;break;
    case 'break': {
      if(f.p===0) {
        const length=f.b-f.a;if(length<8){ret();break;}
        f.length=length;f.rng=String(length);f.modulus=(1n<<BigInt(BigInt(length).toString(2).length)).toString();
        f.i=f.a+Math.floor(length/4)*2-1;f.end=f.i+2;f.p=1;
      } else if(f.i>f.end) ret();
      else { let x=BigInt(f.rng);x=(x^(x<<13n))&MASK;x=(x^(x>>7n))&MASK;x=(x^(x<<17n))&MASK;f.rng=String(x);let other=Number(x&(BigInt(f.modulus)-1n));if(other>=f.length)other-=f.length;sw(f.i,f.a+other);f.i++; }
      break;
    }
    case 'pivot':
      switch(f.p) {
      case 0: { const l=f.b-f.a,q=Math.floor(l/4);f.i=f.a+q;f.j=f.a+q*2;f.k=f.a+q*3;f.swaps=0;if(l>=50){call(f,1,{op:'median',p:0,a:f.i-1,b:f.i,c:f.i+1,swaps:f.swaps});}else f.p=4;break; }
      case 1: f.i=f.rv.index;f.swaps=f.rv.swaps;delete f.rv;call(f,2,{op:'median',p:0,a:f.j-1,b:f.j,c:f.j+1,swaps:f.swaps});break;
      case 2: f.j=f.rv.index;f.swaps=f.rv.swaps;delete f.rv;call(f,3,{op:'median',p:0,a:f.k-1,b:f.k,c:f.k+1,swaps:f.swaps});break;
      case 3: f.k=f.rv.index;f.swaps=f.rv.swaps;delete f.rv;f.p=4;break;
      case 4: if(f.b-f.a>=8)call(f,5,{op:'median',p:0,a:f.i,b:f.j,c:f.k,swaps:f.swaps});else f.p=6;break;
      case 5: f.j=f.rv.index;f.swaps=f.rv.swaps;delete f.rv;f.p=6;break;
      case 6: ret({pivot:f.j,hint:f.swaps===0?'increasing':f.swaps===12?'decreasing':'unknown'});break;
      default:throw Error('Invalid pivot state');
      } break;
    case 'median':
      switch(f.p) {
      case 0: if(cmp(f.b,f.a)){[f.a,f.b]=[f.b,f.a];f.swaps++;}f.p=1;break;
      case 1: if(cmp(f.c,f.b)){[f.b,f.c]=[f.c,f.b];f.swaps++;}f.p=2;break;
      case 2: if(cmp(f.b,f.a)){[f.a,f.b]=[f.b,f.a];f.swaps++;}f.p=3;break;
      case 3: ret({index:f.b,swaps:f.swaps});break;
      default:throw Error('Invalid median state');
      } break;
    case 'partition':
      switch(f.p) {
      case 0: f.i=f.a+1;f.j=f.b-1;f.already=true;f.p=1;sw(f.a,f.pivot);break;
      case 1: if(f.i>f.j){f.p=4;break;} if(cmp(f.i,f.a))f.i++;else f.p=2;break;
      case 2: if(f.i>f.j){f.p=4;break;} if(!cmp(f.j,f.a))f.j--;else f.p=3;break;
      case 3: f.already=false;sw(f.i,f.j);f.i++;f.j--;f.p=1;break;
      case 4: sw(f.j,f.a);f.p=5;break;
      case 5: ret({mid:f.j,already:f.already});break;
      default:throw Error('Invalid partition state');
      } break;
    case 'partitionEqual':
      switch(f.p) {
      case 0:f.i=f.a+1;f.j=f.b-1;f.p=1;sw(f.a,f.pivot);break;
      case 1:if(f.i>f.j){f.p=4;break;}if(!cmp(f.a,f.i))f.i++;else f.p=2;break;
      case 2:if(f.i>f.j){f.p=4;break;}if(cmp(f.a,f.j))f.j--;else f.p=3;break;
      case 3:sw(f.i,f.j);f.i++;f.j--;f.p=1;break;
      case 4:ret(f.i);break;
      default:throw Error('Invalid equal partition state');
      } break;
    case 'partial':
      switch(f.p) {
      case 0:if(f.steps>=5){ret(false);break;} f.p=1;break;
      case 1:if(f.i>=f.b){ret(true);break;}if(!cmp(f.i,f.i-1))f.i++;else f.p=2;break;
      case 2:if(f.b-f.a<50){ret(false);break;}sw(f.i,f.i-1);f.j=f.i-1;f.p=3;break;
      case 3:if(f.i-f.a<2||f.j<1){f.j=f.i+1;f.p=4;break;}if(cmp(f.j,f.j-1)){sw(f.j,f.j-1);f.j--;}else{f.j=f.i+1;f.p=4;}break;
      case 4:if(f.b-f.i<2||f.j>=f.b){f.steps++;f.p=0;break;}if(cmp(f.j,f.j-1)){sw(f.j,f.j-1);f.j++;}else{f.steps++;f.p=0;}break;
      default:throw Error('Invalid partial insertion state');
      } break;
    case 'heap':
      switch(f.p) {
      case 0:f.hi=f.b-f.a;f.i=Math.trunc((f.hi-1)/2);f.p=1;break;
      case 1:if(f.i<0){f.i=f.hi-1;f.p=3;break;}call(f,2,{op:'sift',p:0,root:f.i,hi:f.hi,first:f.a});break;
      case 2:delete f.rv;f.i--;f.p=1;break;
      case 3:if(f.i<0){ret();break;}sw(f.a,f.a+f.i);f.p=4;break;
      case 4:call(f,5,{op:'sift',p:0,root:0,hi:f.i,first:f.a});break;
      case 5:delete f.rv;f.i--;f.p=3;break;
      default:throw Error('Invalid heap state');
      } break;
    case 'sift':
      switch(f.p) {
      case 0:f.child=2*f.root+1;if(f.child>=f.hi){ret();break;}f.p=1;break;
      case 1:if(f.child+1<f.hi && cmp(f.first+f.child,f.first+f.child+1))f.child++;f.p=2;break;
      case 2:if(!cmp(f.first+f.root,f.first+f.child)){ret();break;}sw(f.first+f.root,f.first+f.child);f.root=f.child;f.p=0;break;
      default:throw Error('Invalid sift state');
      } break;
    default:throw Error('Invalid sort frame');
    }
  }
  if(new TextEncoder().encode(JSON.stringify(s)).length>4096) throw Error('Sort checkpoint exceeds lifecycle limit');
  return {state:s,swap,compared};
}
