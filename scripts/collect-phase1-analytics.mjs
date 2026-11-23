// Read-only Cloudflare analytics query. Each response remains a sampled
// aggregate and requires a later recheck for delayed metrics.
import { utcMillis, validateAnalyticsGroups } from './phase1-analytics-validation.mjs';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const [start, end, namespaceId, ...objects] = process.argv.slice(2);
if (!account || !apiToken || !start || !end || !namespaceId || !objects.length) {
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; pass START END NAMESPACE_ID OBJECT_ID...');
}
const startMs = utcMillis(start), endMs = utcMillis(end);
if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{32}$/i.test(namespaceId) || objects.some(id => !/^[a-f0-9]{64}$/i.test(id)) || new Set(objects.map(id => id.toLowerCase())).size !== objects.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
  throw new Error('Invalid account, namespace, object ID, or UTC interval');
}
async function graphql(query, variables = {}) {
  let response;
  try {
    response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch { throw new Error('Cloudflare analytics request failed'); }
  if (!response.ok) throw new Error(`Cloudflare analytics HTTP ${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error('Invalid Cloudflare analytics JSON'); }
  if (!result || typeof result !== 'object' || (result.errors !== undefined && !Array.isArray(result.errors)) || result.errors?.length) throw new Error('Cloudflare analytics query failed; inspect permissions and available schema');
  return result.data;
}
const schema = await graphql(`query { periodic: __type(name: "AccountDurableObjectsPeriodicGroupsFilter_InputObject") { inputFields { name } } invocation: __type(name: "AccountDurableObjectsInvocationsAdaptiveGroupsFilter_InputObject") { inputFields { name } } }`);
for (const type of ['periodic', 'invocation']) {
  if (!Array.isArray(schema?.[type]?.inputFields)) throw new Error(`Invalid analytics ${type} filter schema`);
  const fields = new Set(schema[type].inputFields.map(field => field?.name));
  for (const field of ['datetime_geq', 'datetime_lt', 'namespaceId', 'objectId']) {
    if (!fields.has(field)) throw new Error(`Analytics ${type} filter does not provide ${field}`);
  }
}
const query = `query ($account: String!, $periodic: AccountDurableObjectsPeriodicGroupsFilter_InputObject!, $invocation: AccountDurableObjectsInvocationsAdaptiveGroupsFilter_InputObject!) {
  viewer { accounts(filter: { accountTag: $account }) {
    durableObjectsPeriodicGroups(filter: $periodic, limit: 10000) {
      count dimensions { datetime objectId namespaceId }
      sum { cpuTime exceededCpuErrors exceededMemoryErrors }
      max { memoryUsageBytes }
    }
    durableObjectsInvocationsAdaptiveGroups(filter: $invocation, limit: 10000) {
      dimensions { datetime objectId namespaceId status }
      sum { requests errors wallTime }
    }
  } }
}`;
const results = [];
for (const objectId of objects) {
  const filter = { datetime_geq: new Date(start).toISOString(), datetime_lt: new Date(end).toISOString(), namespaceId, objectId };
  const data = await graphql(query, { account, periodic: filter, invocation: filter });
  results.push(validateAnalyticsGroups(data, namespaceId, objectId, startMs, endMs));
}
const output = JSON.stringify({ start, end, namespaceId, sampled: true, completeness: 'unverified; recheck delayed data', results }, null, 2);
if (output.includes(apiToken)) throw new Error('Analytics output contains credential');
console.log(output);
