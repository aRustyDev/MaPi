import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recoveryEpochConfiguration } from '../worker/recovery-epochs.js';

const target = 'a'.repeat(64);
const other = 'b'.repeat(64);
const env = (raw, id = target) => ({ MAPI_RECOVERY_TARGET_OBJECT: id, MAPI_RECOVERY_OBJECT_EPOCHS: raw });
const invalid = (raw, id = target) => assert.throws(() => recoveryEpochConfiguration(env(raw, id)), /Invalid recovery epoch configuration/);

assert.equal(recoveryEpochConfiguration({}), null);
const valid = { [target]: 'epoch 1', [other]: 'é'.repeat(64) };
assert.deepEqual(recoveryEpochConfiguration(env(JSON.stringify(valid))), valid);
assert.equal(recoveryEpochConfiguration(env(` \n { "${target}" : "epoch\\u0031" } \t`))[target], 'epoch1');
assert.equal(recoveryEpochConfiguration(env(JSON.stringify({ [target]: 'x'.repeat(128) })))[target].length, 128);
for (const epoch of ['a"b', 'a\\b', 'a\nb', 'a\tb', 'a/b', '🌱', 'a\u0000b']) {
  assert.equal(recoveryEpochConfiguration(env(JSON.stringify({ [target]: epoch })))[target], epoch);
}
const maxSupplementary = '🌱'.repeat(32);
assert.equal(recoveryEpochConfiguration(env(JSON.stringify({ [target]: maxSupplementary })))[target], maxSupplementary);
invalid(JSON.stringify({ [target]: maxSupplementary + 'x' }));
for (const malformed of ['\ud800', '\udfff', 'x\ud800y', '\ud800\ud800', '\udfff\udc00']) {
  invalid(JSON.stringify({ [target]: malformed }));
  invalid(JSON.stringify({ [target]: 'valid', [other]: malformed }));
}
// SQLite's UTF-8 conversion demonstrates why unpaired surrogates cannot be
// identifiers for distinct recovery eras. Valid scalar strings stay distinct.
const db = new DatabaseSync(':memory:');
const encode = db.prepare('SELECT hex(CAST(? AS BLOB)) AS value');
assert.equal(encode.get('\ud800').value, encode.get('\udfff').value);
assert.notEqual(encode.get('🌱').value, encode.get('🌿').value);
db.close();

invalid(`{"${target}":"new","${target}":"old"}`);
invalid(`{"${target}":"new","\\u0061${target.slice(1)}":"old"}`);
invalid(`{"${target}":null,"${target}":"new"}`);
invalid(`{"${target}":"new","${other}":"one","${other}":"two"}`);
for (const raw of [
  '', '{}', '[]', 'null', `{"${target}":"x",}`, `{"${target}":"x"} trailing`,
  `{"${target}":"bad\\q"}`, `{"${target}":true}`, `{"${target}":null}`,
  JSON.stringify({ [target]: '' }), JSON.stringify({ [target]: '0' }),
  JSON.stringify({ [target]: 'x'.repeat(129) }), JSON.stringify({ [target]: 'é'.repeat(65) }),
  JSON.stringify({ [other]: 'epoch' }), JSON.stringify({ [target.toUpperCase()]: 'epoch' }),
]) invalid(raw);
invalid(JSON.stringify(valid), target.toUpperCase());
assert.throws(() => recoveryEpochConfiguration({ MAPI_RECOVERY_TARGET_OBJECT: target }), /Invalid recovery epoch configuration/);

console.log('Recovery epoch configuration tests passed');
