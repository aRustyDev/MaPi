import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
// Read-only proof is point-in-time. Refresh immediately before starting;
// this does not prove that a subsequent deployment cannot race the move.
export async function requireEnabledProof(directory, { fresh = true } = {}) {
  const read = name => readFile(resolve(directory, name));
  const reportName = process.env.MAPI_REHEARSAL_ENABLED_REPORT ?? 'provenance-enabled.json';
  if (!/^provenance-enabled(?:-[a-z0-9-]+)?\.json$/.test(reportName)) throw Error('Invalid enabled rehearsal report name');
  const [manifestBytes, fixtureBytes, ownerBytes, controlBytes, reportBytes] = await Promise.all(['manifest.json', 'fixture.private.json', 'owner-enabled.json', 'control-enabled.json', reportName].map(read));
  const manifest = JSON.parse(manifestBytes), fixture = JSON.parse(fixtureBytes), report = JSON.parse(reportBytes);
  if (manifest.local || report.stage !== 'enabled' || report.enabledFlagsVerified !== true || JSON.stringify(report.names) !== JSON.stringify(manifest.names) || fixture.state !== 'prepared' || fixture.rehearsalId !== manifest.id || fixture.origin !== manifest.ownerOrigin || fixture.otherOrigin !== manifest.routerOrigin || report.enabledHashes?.owner !== sha(ownerBytes) || report.enabledHashes?.control !== sha(controlBytes) || report.enabledHashes?.fixture !== sha(fixtureBytes)) throw Error('Enabled rehearsal proof differs from local files');
  const checkedAt = Date.parse(report.checkedAt);
  if (!Number.isFinite(checkedAt) || (fresh && (Date.now() < checkedAt || Date.now() - checkedAt > 5 * 60 * 1000))) throw Error('Enabled rehearsal proof is stale');
  return { manifest, fixture, report };
}
