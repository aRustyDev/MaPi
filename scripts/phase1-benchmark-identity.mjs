// Bind a benchmark child to the parent-selected project and user before setup.
export function benchmarkExpectedIdentity(user, env) {
  if (env.MAPI_PHASE1_CHILD !== '1') return undefined;
  const project = env.MAPI_PHASE1_EXPECTED_PROJECT, userId = env.MAPI_PHASE1_EXPECTED_USER;
  if (typeof project !== 'string' || !project || typeof userId !== 'string' || !userId || user?.projectId !== project) throw new Error('Benchmark fixture identity mismatch');
  return userId;
}
