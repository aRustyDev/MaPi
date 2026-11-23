// Private maintenance authority. The drained-writer assertion is an operator
// prerequisite, not a mechanism for draining previously deployed code.
export function authorizeSchemaMigration(env, secret) {
  const expected = env.MAPI_SCHEMA_CONTROL_TOKEN;
  if (env.MAPI_SCHEMA_MIGRATION_ENABLED !== '1' || env.MAPI_FENCE_WRITERS_DRAINED !== '1' || !expected || typeof secret !== 'string' || secret.length !== expected.length) throw new Error('Schema migration control denied');
  let difference = 0;
  for (let index = 0; index < secret.length; index++) difference |= secret.charCodeAt(index) ^ expected.charCodeAt(index);
  if (difference) throw new Error('Schema migration control denied');
}
