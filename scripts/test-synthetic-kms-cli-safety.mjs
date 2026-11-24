import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertAssumedIdentity, assertPinnedAwsCli, assertSystemCa, awsCli, AWS_CLI, CA_BUNDLE, safeBaseEnvironment } from './synthetic-kms-cli-safety.mjs';

const unsafe = { AWS_ENDPOINT_URL: 'bad', AWS_ENDPOINT_URL_STS: 'bad', aws_endpoint_url_kms: 'bad',
  AWS_CA_BUNDLE: 'bad', REQUESTS_CA_BUNDLE: 'bad', CURL_CA_BUNDLE: 'bad', SSL_CERT_FILE: 'bad', SSL_CERT_DIR: 'bad',
  NODE_EXTRA_CA_CERTS: 'bad', HTTPS_PROXY: 'bad', http_proxy: 'bad', ALL_PROXY: 'bad', AWS_ACCESS_KEY_ID: 'bad',
  AWS_SECRET_ACCESS_KEY: 'bad', AWS_SESSION_TOKEN: 'bad', AWS_PROFILE: 'bad', AWS_DEFAULT_PROFILE: 'bad',
  AWS_CONFIG_FILE: 'bad', AWS_SHARED_CREDENTIALS_FILE: 'bad', AWS_ROLE_ARN: 'bad', AWS_WEB_IDENTITY_TOKEN_FILE: 'bad',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: 'bad', AWS_DATA_PATH: 'bad', PYTHONPATH: 'bad',
  DYLD_INSERT_LIBRARIES: 'bad', LD_PRELOAD: 'bad', __PYVENV_LAUNCHER__: 'bad', SSLKEYLOGFILE: 'bad',
  BASH_ENV: 'bad', ENV: 'bad', NODE_OPTIONS: 'bad', PATH: '/tmp/bad',
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false', LANG: 'ok' };
const safe = safeBaseEnvironment(unsafe);
for (const key of Object.keys(unsafe)) if (!['LANG', 'PATH', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'].includes(key)) assert.equal(Object.hasOwn(safe, key), false);
assert.equal(safe.LANG, 'ok'); assert.equal(safe.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, 'true');
assert.equal(safe.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');

const account = '646535719915', role = 'synthetic', id = 'AROAZNCEIFPV23UFUR333';
const identity = { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/${role}/session-1`, UserId: `${id}:session-1` };
assert.doesNotThrow(() => assertAssumedIdentity(identity, account, role, id));
for (const value of [ { ...identity, Account: '111111111111' }, { ...identity, UserId: 'AROAREPLACED:session-1' },
  { ...identity, Arn: `arn:aws:sts::${account}:assumed-role/other/session-1` }, { ...identity, UserId: `${id}:other` } ])
  assert.throws(() => assertAssumedIdentity(value, account, role, id), /identity mismatch/);

function entry(type, uid = 0, mode = 0o755, size = 1) {
  return { uid, mode, size, isDirectory: () => type === 'dir', isFile: () => type === 'file' };
}
const opts = { platform: 'darwin', realpath: () => '/private/etc/ssl/cert.pem', stat: path => entry(path.endsWith('cert.pem') ? 'file' : 'dir') };
assert.doesNotThrow(() => assertSystemCa(opts));
assert.throws(() => assertSystemCa({ ...opts, platform: 'linux' }), /System CA/);
assert.throws(() => assertSystemCa({ ...opts, realpath: () => '/tmp/custom.pem' }), /System CA/);
assert.throws(() => assertSystemCa({ ...opts, stat: path => entry(path.endsWith('cert.pem') ? 'file' : 'dir', 501) }), /System CA/);
assert.throws(() => assertSystemCa({ ...opts, stat: path => entry(path.endsWith('cert.pem') ? 'file' : 'dir', 0, 0o777) }), /System CA/);
const cliOpts = { platform: 'darwin', realpath: () => AWS_CLI, stat: () => entry('file') };
assert.doesNotThrow(() => assertPinnedAwsCli(cliOpts));
assert.throws(() => assertPinnedAwsCli({ ...cliOpts, platform: 'linux' }), /Pinned AWS CLI/);
assert.throws(() => assertPinnedAwsCli({ ...cliOpts, realpath: () => '/tmp/aws' }), /Pinned AWS CLI/);
assert.throws(() => assertPinnedAwsCli({ ...cliOpts, stat: () => entry('file', 0, 0o777) }), /Pinned AWS CLI/);

function fakeSpawn(record) {
  return (bin, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.killed = false; child.kill = () => { child.killed = true; };
    record.bin = bin; record.args = args; record.options = options; record.child = child; return child;
  };
}
const record = {};
const pending = awsCli(['sts', 'get-caller-identity'], safe, undefined, { spawnFn: fakeSpawn(record), timeoutMs: 15 });
const rejection = assert.rejects(pending, /timed out/);
assert.equal(record.bin, AWS_CLI); assert.ok(record.args.includes('--ca-bundle')); assert.equal(record.args[record.args.indexOf('--ca-bundle') + 1], CA_BUNDLE);
const early = Buffer.from('private-before-timeout'); record.child.stdout.emit('data', early);
await rejection; assert.equal(record.child.killed, true); assert.ok(early.every(value => value === 0));
const lateOut = Buffer.from('private-late-output'), lateErr = Buffer.from('private-late-error');
record.child.stdout.emit('data', lateOut); record.child.stderr.emit('data', lateErr);
assert.ok(lateOut.every(value => value === 0)); assert.ok(lateErr.every(value => value === 0));
assert.throws(() => awsCli(['sts', '--endpoint-url=https://bad'], safe), /Invalid synthetic AWS CLI arguments/);
assert.throws(() => awsCli(['sts', '--ca-bundle', '/tmp/bad'], safe), /Invalid synthetic AWS CLI arguments/);

const success = {};
const response = awsCli(['sts', 'get-caller-identity'], safe, undefined, { spawnFn: fakeSpawn(success), timeoutMs: 1000 });
const bytes = Buffer.from('{"ok":true}'); success.child.stdout.emit('data', bytes); success.child.emit('close', 0);
assert.deepEqual(await response, { ok: true }); assert.ok(bytes.every(value => value === 0));

console.log('Synthetic KMS CLI safety tests passed; no AWS request was made.');
