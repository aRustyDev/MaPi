import { DurableObject } from 'cloudflare:workers';
import { advanceRelocationTextPreflight } from '../worker/relocation-text-preflight.js';
import { readRelocationRow } from '../worker/sql.js';

const budget = 256 * 1024;
const identity = { projectId: 'synthetic', generation: 1, moveId: 'synthetic-move' };
const check = (condition, message) => { if (!condition) throw Error(message); };
const utf8 = value => new TextEncoder().encode(value).length;

export class CursorSizingProbe extends DurableObject {
  run() {
    const storage = this.ctx.storage, sql = storage.sql;
    sql.exec('CREATE TABLE records (a, b, c, padding, PRIMARY KEY(a, b, c))');

    const cases = [
      ['ascii', 'a'.repeat(900), 17, new Uint8Array([0, 1, 255])],
      ['quotes', '"\\'.repeat(150), -42, new Uint8Array(13)],
      ['control', '\u0000\b\t\n\f\r\u001f', 0, new Uint8Array(1)],
      ['multibyte', '\uFEFFé😀'.repeat(50), 9223372036854775807n, new Uint8Array(32)],
      ['separators', '\u2028\u2029\uFFFE\uFFFF\u{10FFFF}', 2, new Uint8Array(2)],
      ['empty', '', -9223372036854775808n, new Uint8Array()],
    ];
    // Differentially compare against JSON.stringify of the bridge's actual
    // returned cursor, including variable-width code points and escapes.
    let seed = 0x43a91;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let index = 0; index < 40; index++) {
      let value = '';
      for (let length = 5 + next() % 90; length > 0; length--) {
        const choice = next() % 5;
        const point = choice === 0 ? next() % 128
          : choice === 1 ? 0x80 + next() % (0x800 - 0x80)
          : choice === 2 ? 0x800 + next() % (0xd800 - 0x800)
          : choice === 3 ? 0xe000 + next() % (0x10000 - 0xe000)
          : 0x10000 + next() % (0x110000 - 0x10000);
        value += String.fromCodePoint(point);
      }
      cases.push([`differential-${index}`, value, index - 20, new Uint8Array(next() % 20)]);
    }
    for (const [label, text, integer, blob] of cases) {
      sql.exec('DELETE FROM records');
      const integerText = String(integer);
      sql.exec('INSERT INTO records (a,b,c,padding) VALUES (?,CAST(? AS INTEGER),?,?)', text, integerText, blob, 'x'.repeat(budget - utf8(text)));
      const page = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['records'], null, identity));
      const actual = readRelocationRow(storage, ['a', 'b', 'c'], 'FROM records ORDER BY rowid LIMIT 1', []);
      const expected = utf8(JSON.stringify(actual));
      check(JSON.stringify(actual) === JSON.stringify([text, { integer: integerText }, { blob: blob.toBase64() }]), `${label}: bridge cursor differs`);
      check(!page.done && page.checkpoint.cursorBytes === expected, `${label}: cursor byte count differs (got ${page.checkpoint.cursorBytes}, expected ${expected}, done ${page.done})`);
      check(page.bytes === budget && page.queries <= 128 && page.rows <= 64, `${label}: page budget differs`);
      const second = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['records'], page.checkpoint, identity));
      check(second.done, `${label}: scan did not complete`);
    }

    sql.exec('CREATE TABLE text_keys (key TEXT PRIMARY KEY, padding TEXT)');
    function keyCase(value, allowed) {
      sql.exec('DELETE FROM text_keys');
      sql.exec('INSERT INTO text_keys VALUES (?, ?)', value, '');
      let result;
      try { result = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['text_keys'], null, identity)); }
      catch (error) {
        if (allowed || !String(error).includes('Relocation primary key exceeds cursor limit')) throw error;
        return;
      }
      if (!allowed || !result.done) throw Error('Cursor limit outcome differs');
    }
    keyCase('a'.repeat(4092), true);
    keyCase('a'.repeat(4093), false);
    keyCase('"'.repeat(2046), true);
    keyCase('"'.repeat(2047), false);
    keyCase('\u0000'.repeat(682), true);
    keyCase('\u0000'.repeat(683), false);
    keyCase('😀'.repeat(1023), true);
    keyCase('😀'.repeat(1024), false);

    sql.exec('CREATE TABLE blob_keys (key BLOB PRIMARY KEY, padding TEXT)');
    for (const [size, allowed] of [[3060, true], [3061, false]]) {
      sql.exec('DELETE FROM blob_keys');
      sql.exec('INSERT INTO blob_keys VALUES (?, ?)', new Uint8Array(size), '');
      let page;
      try { page = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['blob_keys'], null, identity)); }
      catch (error) { if (allowed || !String(error).includes('Relocation primary key exceeds cursor limit')) throw error; continue; }
      check(allowed && page.done, 'BLOB cursor limit outcome differs');
    }

    sql.exec('CREATE TABLE real_keys (key REAL PRIMARY KEY, padding TEXT)');
    for (const value of [1.5, -0.5, 1e-310, -3.4028234663852886e38]) {
      sql.exec('DELETE FROM real_keys');
      sql.exec('INSERT INTO real_keys VALUES (CAST(? AS REAL), ?)', value, 'p'.repeat(budget));
      const page = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['real_keys'], null, identity));
      check(page.checkpoint.cursorBytes === utf8(JSON.stringify([value])), 'REAL cursor byte count differs');
      check(storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['real_keys'], page.checkpoint, identity)).done, 'REAL scan did not complete');
    }

    sql.exec('CREATE TABLE split_keys (padding TEXT, key TEXT PRIMARY KEY)');
    sql.exec('INSERT INTO split_keys VALUES (?, ?)', 'p'.repeat(budget - 1), '😀x');
    const first = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['split_keys'], null, identity));
    check(!first.done && first.checkpoint.remaining === 3 && first.checkpoint.cursorBytes === 5, 'Split UTF-8 checkpoint differs');
    const saved = JSON.parse(JSON.stringify(first.checkpoint));
    const resumed = storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['split_keys'], saved, identity));
    check(resumed.done && saved.remaining === 3, 'Split UTF-8 resume differs');

    const legacy = { ...first.checkpoint, version: 3 };
    let rejected = false;
    try { storage.transactionSync(() => advanceRelocationTextPreflight(storage, ['split_keys'], legacy, identity)); }
    catch (error) { if (!String(error).includes('Invalid TEXT preflight checkpoint')) throw error; rejected = true; }
    check(rejected, 'Legacy checkpoint was accepted');
    return { ok: true, cases: cases.length, boundaryCases: 10, realCases: 4, splitResume: true };
  }
}

export default { async fetch(request, env) { return Response.json(await env.PROBE.getByName('synthetic-cursor').run()); } };
