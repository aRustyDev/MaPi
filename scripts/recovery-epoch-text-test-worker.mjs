import { DurableObject } from 'cloudflare:workers';
import { recoveryEpochConfiguration } from '../worker/recovery-epochs.js';

export class EpochTextProbe extends DurableObject {
  async fetch() {
    const target = 'a'.repeat(64);
    const get = (epoch) => recoveryEpochConfiguration({
      MAPI_RECOVERY_TARGET_OBJECT: target,
      MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [target]: epoch }),
    })[target];
    const malformed = ['\ud800', '\udfff', 'x\ud800y'];
    const rejected = malformed.every((epoch) => {
      try { get(epoch); return false; } catch { return true; }
    });
    const valid = ['🌱', '🌿', '🌱'.repeat(32)];
    const valuesPreserved = valid.every((epoch) => get(epoch) === epoch);
    const hex = (value) => this.ctx.storage.sql.exec('SELECT hex(CAST(? AS BLOB)) AS value', value).one().value;
    let malformedBinding;
    try {
      const read = (value) => this.ctx.storage.sql.exec('SELECT ? AS value', value).one().value;
      const first = read(malformed[0]), second = read(malformed[1]);
      malformedBinding = { first: hex(malformed[0]), second: hex(malformed[1]), readDistinct: first !== second, preserved: first === malformed[0] && second === malformed[1] };
    }
    catch { malformedBinding = 'rejected'; }
    return Response.json({ rejected, valuesPreserved, validDistinct: hex(valid[0]) !== hex(valid[1]), malformedBinding });
  }
}

export default {
  fetch(request, env) { return env.PROBE.getByName('epoch-text').fetch(request); },
};
