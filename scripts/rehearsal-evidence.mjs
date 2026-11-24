// Validate the disposable fixture's pre-move baseline before using it as an
// independent check against the coordinator's reconciliation journal.
export async function readRehearsalCounts(response) {
  if (response?.status !== 200) throw Error('Rehearsal count request failed');
  const counts = await response.json();
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      !['projects', 'users', 'events'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      counts.projects !== 1 || counts.users < 1 || counts.events < 1) {
    throw Error('Invalid rehearsal count baseline');
  }
  return { projects: counts.projects, users: counts.users, events: counts.events };
}

export function assertRehearsalEvidenceCounts(evidenceCounts, counts) {
  for (const table of ['users', 'events']) {
    if (!evidenceCounts.has(table) || evidenceCounts.get(table) !== counts[table]) {
      throw Error(`Reconciled ${table} differ from the pre-move baseline`);
    }
  }
}

export function rehearsalEvidenceDone(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      evidence.complete !== true || typeof evidence.done !== 'boolean' || !Array.isArray(evidence.pages)) {
    throw Error('Invalid rehearsal evidence page');
  }
  return evidence.done;
}
