import { putArchiveObject as putWithSignal } from '../worker/archive-object-store.js';

const putArchiveObject = (bucket, key, value, maxBytes) => putWithSignal(bucket, key, value, maxBytes, AbortSignal.timeout(10000));

function assert(ok, message) { if (!ok) throw new Error(message); }
async function rejected(action) {
  try { await action(); } catch { return; }
  throw new Error('Expected archive object rejection');
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/ready') return new Response(null, { status: 204 });
    try {
      const bucket = env.ARCHIVE_TEST;
      const one = new Uint8Array([0, 1, 2, 255]);
      assert((await putArchiveObject(bucket, 'first', one, 8)).created, 'create');
      assert(!(await putArchiveObject(bucket, 'first', one, 8)).created, 'retry');
      await rejected(() => putArchiveObject(bucket, 'first', new Uint8Array([0, 1, 2, 3]), 8));
      assert((await (await bucket.get('first')).arrayBuffer()).byteLength === one.length, 'conflict changed size');
      assert([...new Uint8Array(await (await bucket.get('first')).arrayBuffer())].join(',') === [...one].join(','), 'conflict changed bytes');

      let drop = true;
      const lostAcknowledgement = {
        get: (...args) => bucket.get(...args),
        async put(...args) {
          const result = await bucket.put(...args);
          if (drop) { drop = false; throw new Error('simulated lost acknowledgement'); }
          return result;
        },
      };
      assert(!(await putArchiveObject(lostAcknowledgement, 'ack', one, 8)).created, 'lost acknowledgement');
      assert(!(await putArchiveObject(bucket, 'ack', one, 8)).created, 'retry after lost acknowledgement');

      const concurrent = await Promise.allSettled([
        putArchiveObject(bucket, 'race', one, 8),
        putArchiveObject(bucket, 'race', new Uint8Array([9, 8, 7, 6]), 8),
      ]);
      assert(concurrent.filter(v => v.status === 'fulfilled').length === 1, 'conflicting concurrent writes');

      await rejected(() => putArchiveObject(bucket, 'oversized', one, 3));
      assert(await bucket.get('oversized') === null, 'oversize persisted');
      await rejected(() => putArchiveObject(bucket, '\ud800', one, 8));
      const boundary = new Uint8Array(1024 * 1024); boundary[boundary.length - 1] = 3;
      assert((await putArchiveObject(bucket, 'boundary', boundary, boundary.length)).created, 'boundary');
      await rejected(() => putArchiveObject(bucket, 'beyond', boundary, boundary.length + 1));

      let canceled = false;
      const badStream = {
        async put() { throw new Error('private diagnostic should not escape'); },
        async get() { return { size: one.length, body: { getReader() { return {
          async read() { return { done: false, value: new Uint8Array([9]) }; },
          cancel() { canceled = true; return new Promise(() => {}); },
          releaseLock() {},
        }; } } }; },
      };
      await rejected(() => putArchiveObject(badStream, 'ignored', one, 8));
      assert(canceled, 'invalid read did not cancel');
      let mismatchCanceled = false;
      const mismatched = {
        async put() { return null; },
        async get() { return { size: one.length + 1, body: { cancel() { mismatchCanceled = true; return Promise.reject(Error('private')); } } }; },
      };
      await rejected(() => putArchiveObject(mismatched, 'ignored', one, 8));
      assert(mismatchCanceled, 'mismatched body did not cancel');

      let releaseLate, markStarted, markFinished;
      const started = new Promise(resolve => { markStarted = resolve; });
      const lateFinished = new Promise(resolve => { markFinished = resolve; });
      const barrier = new Promise(resolve => { releaseLate = resolve; });
      const late = {
        get: (...args) => bucket.get(...args),
        async put(...args) { markStarted(); await barrier; try { return await bucket.put(...args); } finally { markFinished(); } },
      };
      const controller = new AbortController();
      const waiting = putWithSignal(late, 'late', one, 8, controller.signal);
      await started;
      controller.abort();
      await rejected(() => waiting);
      releaseLate();
      await lateFinished;
      assert(!(await putArchiveObject(bucket, 'late', one, 8)).created, 'late write exact retry');
      await rejected(() => putArchiveObject(bucket, 'late', new Uint8Array([7, 7, 7, 7]), 8));

      let readStarted, readCanceled = false;
      const reading = new Promise(resolve => { readStarted = resolve; });
      const pendingRead = {
        async put() { return null; },
        async get() { return { size: one.length, body: { getReader() { return {
          read() { readStarted(); return new Promise(() => {}); },
          cancel() { readCanceled = true; return Promise.reject(Error('private')); },
          releaseLock() {},
        }; } } }; },
      };
      const readController = new AbortController();
      const readWait = putWithSignal(pendingRead, 'ignored', one, 8, readController.signal);
      await reading;
      readController.abort();
      await rejected(() => readWait);
      assert(readCanceled, 'aborted read did not cancel');
      let getStarted, releaseGet, lateGetCanceled;
      const getting = new Promise(resolve => { getStarted = resolve; });
      const getCanceled = new Promise(resolve => { lateGetCanceled = resolve; });
      const pendingGet = {
        async put() { return null; },
        get() { getStarted(); return new Promise(resolve => { releaseGet = resolve; }); },
      };
      const getController = new AbortController();
      const getWait = putWithSignal(pendingGet, 'ignored', one, 8, getController.signal);
      await getting;
      getController.abort();
      await rejected(() => getWait);
      releaseGet({ size: one.length, body: { cancel() { lateGetCanceled(); return Promise.reject(Error('private')); } } });
      await getCanceled;
      await rejected(() => putWithSignal(bucket, 'ignored', one, 8));
      const missing = { async put() { throw new Error('secret diagnostic'); }, async get() { return null; } };
      try { await putArchiveObject(missing, 'private-key', one, 8); throw new Error('expected missing rejection'); }
      catch (error) { assert(error.message === 'Archive object verification failed', 'failure leaked diagnostic'); }
      return new Response('archive object store passed');
    } catch (error) {
      return new Response(`archive object store failed: ${error.message}`, { status: 500 });
    }
  },
};
