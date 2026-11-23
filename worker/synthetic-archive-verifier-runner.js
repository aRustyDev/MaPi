// Synthetic, unmounted archive-verifier runner. Only an independently
// administered service binding may supply the fixed configuration and the
// two authority capabilities. This does not establish independent custody,
// source-commitment authority, nonrollback storage or permission to cut over.
// In particular, binding the underlying mutable authority to an untrusted
// caller would allow it to bypass this runner entirely.
import { beginSyntheticVerification, advanceSyntheticVerification } from './synthetic-relocation-archive.js';

function checkSignal(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') throw Error('Invalid archive verifier signal');
  if (signal.aborted) throw Error('Archive verifier canceled');
}
async function readHead(authority, jobId, signal) {
  checkSignal(signal);
  let result;
  // A service RPC may never settle. Cancellation ends our wait but cannot
  // revoke the already dispatched read. Discard both late values and errors.
  try {
    result = await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, Error('Archive verifier canceled'));
      signal.addEventListener('abort', onAbort, { once:true });
      Promise.resolve().then(() => {
        checkSignal(signal);
        return authority.read(jobId);
      }).then(value => finish(resolve,value), error => finish(reject,error));
      if (signal.aborted) onAbort();
    });
  }
  catch { checkSignal(signal); throw Error('Archive authority unavailable'); }
  checkSignal(signal);
  // A service-binding RPC returns a detached value, but this helper also
  // supports trusted local adapters. Snapshot before another await can let a
  // mutable local adapter change the object we just observed.
  try { return JSON.parse(JSON.stringify(result)); }
  catch { throw Error('Invalid archive authority head'); }
}

// Advance one bounded verification step without accepting a caller-supplied
// head, checkpoint, commitment, job id or iteration count. The caller supplies
// only a cancellation signal. Configuration must already have been checked
// and pinned by the privileged service, not by the archive writer.
export async function advanceConfiguredSyntheticVerifier(config, bucket, kms, sealingAuthority, verificationAuthority, signal) {
  checkSignal(signal);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.sealingJobId !== 'string' || !/^[0-9a-f]{32}$/.test(config.sealingJobId) ||
      typeof config.verificationJobId !== 'string' || !/^[0-9a-f]{32}$/.test(config.verificationJobId) ||
      config.sealingJobId === config.verificationJobId ||
      !sealingAuthority || typeof sealingAuthority.read !== 'function' ||
      !verificationAuthority || typeof verificationAuthority.read !== 'function' ||
      typeof verificationAuthority.create !== 'function' || typeof verificationAuthority.compareAndSwap !== 'function') {
    throw Error('Invalid configured archive verifier');
  }
  // Detach the privileged configuration before the first await. The actual
  // archive implementation validates the full scope/commitment and signal.
  let fixed;
  try { fixed = JSON.parse(JSON.stringify({ scope:config.scope, commitment:config.commitment,
    envelopeDigest:config.envelopeDigest, sealingJobId:config.sealingJobId, verificationJobId:config.verificationJobId })); }
  catch { throw Error('Invalid configured archive verifier'); }
  const sealHead = await readHead(sealingAuthority,fixed.sealingJobId,signal);
  if (!sealHead || sealHead.terminal !== true) throw Error('Sealing authorization incomplete');
  const seal = { authority:sealingAuthority, jobId:fixed.sealingJobId, head:sealHead };
  const current = await readHead(verificationAuthority,fixed.verificationJobId,signal);
  if (current === null) {
    const head = await beginSyntheticVerification(bucket,kms,fixed.scope,fixed.commitment,fixed.envelopeDigest,
      signal,verificationAuthority,fixed.verificationJobId,seal);
    return { complete:false, head };
  }
  return advanceSyntheticVerification(bucket,kms,fixed.scope,fixed.commitment,fixed.envelopeDigest,
    signal,verificationAuthority,fixed.verificationJobId,current,4,seal);
}
