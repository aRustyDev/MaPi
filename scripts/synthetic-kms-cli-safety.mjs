// Helpers for the opt-in synthetic KMS CLI test. Never log child output on
// failure: it can contain temporary credentials or plaintext data-key bytes.
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';

export const CA_BUNDLE = '/etc/ssl/cert.pem';
export const AWS_CLI = '/opt/homebrew/Cellar/awscli/2.37.0/libexec/bin/aws';

// This opt-in synthetic test is deliberately limited to the canonical macOS
// system bundle. This checks path/ownership, not the trust store's contents.
export function assertSystemCa({ platform = process.platform, realpath = realpathSync, stat = statSync } = {}) {
  if (platform !== 'darwin' || realpath(CA_BUNDLE) !== '/private/etc/ssl/cert.pem') throw new Error('System CA bundle unavailable');
  for (const [index, path] of ['/private', '/private/etc', '/private/etc/ssl', '/private/etc/ssl/cert.pem'].entries()) {
    const entry = stat(path);
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0 || (index < 3 ? !entry.isDirectory() : !entry.isFile()) || (index === 3 && entry.size < 1)) throw new Error('System CA bundle unavailable');
  }
}

// Pin the currently supported Homebrew executable rather than resolving PATH.
// This does not establish binary provenance or a trustworthy local host.
export function assertPinnedAwsCli({ platform = process.platform, realpath = realpathSync, stat = statSync } = {}) {
  if (platform !== 'darwin' || realpath(AWS_CLI) !== AWS_CLI) throw new Error('Pinned AWS CLI unavailable');
  const entry = stat(AWS_CLI);
  if (!entry.isFile() || !(entry.mode & 0o111) || (entry.mode & 0o022) !== 0) throw new Error('Pinned AWS CLI unavailable');
}

// A role name alone is insufficient if an IAM role was deleted/recreated.
export function assertAssumedIdentity(identity, account, roleName, roleId) {
  if (!identity || identity.Account !== account || typeof identity.Arn !== 'string' || typeof identity.UserId !== 'string') throw new Error('Assumed role identity mismatch');
  const prefix = `arn:aws:sts::${account}:assumed-role/${roleName}/`;
  if (!identity.Arn.startsWith(prefix)) throw new Error('Assumed role identity mismatch');
  const session = identity.Arn.slice(prefix.length);
  if (!/^[A-Za-z0-9+=,.@_-]+$/.test(session) || identity.UserId !== `${roleId}:${session}`) throw new Error('Assumed role identity mismatch');
}

export function safeBaseEnvironment(input) {
  const env = {};
  // Preserve only ordinary OS/locale settings needed by the selected profile.
  // In particular, do not inherit Python, loader, shell, proxy, CA, endpoint,
  // credential-provider or alternate AWS-config overrides.
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'TERM']);
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) env[key] = value;
  }
  return { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
}

export function awsCli(args, env, input, { spawnFn = spawn, timeoutMs = 25000 } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /^(?:--endpoint-url|--ca-bundle|--no-verify-ssl)(?:=|$)/.test(arg))) throw new Error('Invalid synthetic AWS CLI arguments');
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(AWS_CLI, [...args, '--region', 'us-east-1', '--no-cli-pager', '--output', 'json', '--ca-bundle', CA_BUNDLE], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error('AWS CLI unavailable')); return; }
    const output = [], errors = []; let outBytes = 0, errorBytes = 0, settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('AWS request timed out')); }, timeoutMs);
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const buffer of [...output, ...errors]) buffer.fill(0);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      outBytes += chunk.length;
      if (outBytes > 65536) { chunk.fill(0); child.kill(); finish(new Error('AWS response exceeded bound')); } else output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      errorBytes += chunk.length;
      if (errorBytes > 16384) { chunk.fill(0); child.kill(); finish(new Error('AWS error exceeded bound')); } else errors.push(chunk);
    });
    child.on('error', () => finish(new Error('AWS CLI unavailable')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        const bytes = Buffer.concat(errors);
        const reason = bytes.includes(Buffer.from('Token has expired')) || bytes.includes(Buffer.from('SSO session associated with this profile has expired')) ? 'AWS SSO authentication expired' :
          bytes.includes(Buffer.from('AccessDenied')) ? 'AWS request denied' : bytes.includes(Buffer.from('Could not connect')) || bytes.includes(Buffer.from('endpoint URL')) ? 'AWS endpoint unavailable' : 'AWS request failed';
        bytes.fill(0); finish(new Error(reason)); return;
      }
      const bytes = Buffer.concat(output);
      try { const value = JSON.parse(bytes.toString('utf8')); bytes.fill(0); finish(null, value); }
      catch { bytes.fill(0); finish(new Error('Invalid AWS response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
