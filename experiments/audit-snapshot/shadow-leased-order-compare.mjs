// Unmounted adapter for a trusted synchronous external sort. It compares one
// pair using individually fenced, bounded ordering fragments. It does not
// authenticate sort state, select or validate a complete page, or bound total
// comparisons, work, storage or synchronous duration.
import { readShadowOrderFragment } from './shadow-order-fragment.mjs';

const decoder=new TextDecoder('utf-8',{fatal:true});
const fragmentBytes=32*1024;
function read(storage,scope,reader,use,authorize,handle,offset) {
  const frame=JSON.parse(decoder.decode(readShadowOrderFragment(storage,scope,reader,use,authorize,handle,offset)));
  const part=Uint8Array.fromBase64(frame.fragment);
  if (frame.offset!==offset || part.byteLength>fragmentBytes) throw Error('Invalid leased ordering fragment');
  return {...frame,part};
}

export function compareLeasedShadowEvents(storage,scope,reader,use,authorize,leftHandle,rightHandle,direction) {
  if (direction!=='asc' && direction!=='desc') throw Error('Invalid shadow ordering direction');
  let left=read(storage,scope,reader,use,authorize,leftHandle,0);
  let right=read(storage,scope,reader,use,authorize,rightHandle,0);
  const leftTime=BigInt(left.timestamp),rightTime=BigInt(right.timestamp);
  let order=leftTime===rightTime ? 0 : leftTime<rightTime ? -1 : 1;
  if (!order) {
    const leftLength=left.idLength,rightLength=right.idLength,leftKind=left.idKind,rightKind=right.idKind;
    const common=Math.min(leftLength,rightLength);
    for (let offset=0;offset<common;offset+=fragmentBytes) {
      if (offset) {
        left=read(storage,scope,reader,use,authorize,leftHandle,offset);
        right=read(storage,scope,reader,use,authorize,rightHandle,offset);
      }
      if (left.idLength!==leftLength || right.idLength!==rightLength || left.idKind!==leftKind || right.idKind!==rightKind ||
          BigInt(left.timestamp)!==leftTime || BigInt(right.timestamp)!==rightTime) throw Error('Shadow ordering value changed');
      const count=Math.min(fragmentBytes,common-offset);
      for (let i=0;i<count;i++) if(left.part[i]!==right.part[i]) { order=left.part[i]<right.part[i] ? -1 : 1; break; }
      if (order) break;
    }
    if (!order && leftLength!==rightLength) order=leftLength<rightLength ? -1 : 1;
  }
  return direction==='asc' ? order : -order;
}
