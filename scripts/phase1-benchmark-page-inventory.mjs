// Read-only inventory of the documented, paginated Cloudflare search/list APIs.
// Matching page metadata checks token-visible pages only; it does not prove
// account-wide visibility or an atomic snapshot during concurrent changes.
const LIMITS = { scripts: 100, namespaces: 1000 };

function pageMetadata(result, page, requested, expectedTotal) {
  const info = result?.result_info, rows = result?.result;
  if (!Array.isArray(rows) || !info || info.page !== page || !Number.isSafeInteger(info.count) || info.count !== rows.length || !Number.isSafeInteger(info.total_count) || info.total_count < 0 || !Number.isSafeInteger(info.per_page)) throw Error('Incomplete inventory pagination metadata');
  if (info.total_count === 0) {
    if (page !== 1 || rows.length !== 0 || ![0, 1].includes(info.total_pages ?? 0) || info.per_page < 0 || info.per_page > requested) throw Error('Inconsistent empty inventory');
    return { total: 0, pages: 1, perPage: info.per_page };
  }
  if (info.per_page < 1 || info.per_page > requested || rows.length > info.per_page) throw Error('Invalid inventory page size');
  const pages = Math.ceil(info.total_count / info.per_page);
  if ((info.total_pages !== undefined && info.total_pages !== pages) || page > pages || (page < pages && rows.length !== info.per_page) || (page === pages && rows.length !== info.total_count - info.per_page * (pages - 1))) throw Error('Incomplete inventory page');
  if (expectedTotal && (expectedTotal.total !== info.total_count || expectedTotal.perPage !== info.per_page || expectedTotal.pages !== pages)) throw Error('Inventory changed during pagination');
  return { total: info.total_count, pages, perPage: info.per_page };
}

export async function allPages(get, endpoint, requested, validate, identity) {
  const rows = [], seen = new Set();
  let expected;
  for (let page = 1; ; page++) {
    const result = await get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}&per_page=${requested}`);
    const meta = pageMetadata(result, page, requested, expected);
    expected ??= meta;
    for (const row of result.result) {
      validate(row);
      const key = identity(row);
      if (seen.has(key)) throw Error('Duplicate inventory row');
      seen.add(key);
      rows.push(row);
    }
    if (page === meta.pages) {
      if (rows.length !== meta.total) throw Error('Inventory count mismatch');
      return rows;
    }
  }
}

function validateScript(row) {
  if (!row || typeof row.id !== 'string' || !row.id ||
      typeof row.script_name !== 'string' || !row.script_name ||
      (row.environment_name !== undefined && typeof row.environment_name !== 'string') ||
      (row.service_name !== undefined && (typeof row.service_name !== 'string' || !row.service_name))) {
    throw Error('Unknown Worker script identity');
  }
}

export async function readBenchmarkScripts(get) {
  const endpoint = '/workers/scripts-search';
  const firstPath = `${endpoint}?page=1&per_page=${LIMITS.scripts}`;
  const first = await get(firstPath);
  const info = first?.result_info;
  const missingPagination = info === undefined ||
    (info !== null && typeof info === 'object' && !Array.isArray(info) && Object.keys(info).length === 0);
  if (!missingPagination) {
    // Present but incomplete metadata still fails the normal pagination
    // check. Only the API's absent/empty optional object takes the other path.
    return allPages(path => path === firstPath ? first : get(path), endpoint, LIMITS.scripts,
      validateScript, row => JSON.stringify([row.id, row.script_name, row.environment_name ?? null]));
  }

  // Script Search can omit its optional pagination object. Corroborate
  // identities against the paginated List Workers endpoint before using
  // the search rows, which also carry service and environment aliases.
  if (!Array.isArray(first?.result)) throw Error('Invalid Worker script inventory');
  const searched = new Map();
  for (const row of first.result) {
    validateScript(row);
    if (searched.has(row.id)) throw Error('Ambiguous Worker script identity');
    searched.set(row.id, row.script_name);
  }
  const listed = await allPages(get, '/workers/workers', LIMITS.scripts, row => {
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) {
      throw Error('Unknown listed Worker identity');
    }
  }, row => row.id);
  if (searched.size !== listed.length || listed.some(row => searched.get(row.id) !== row.name)) {
    throw Error('Worker inventory sources differ');
  }
  return first.result;
}

export async function readFreshInventory(get, names) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw Error('Invalid generated names');
  const values = Object.values(names);
  if (values.length !== 4 || values.some(name => typeof name !== 'string' || !name) || new Set(values).size !== values.length) throw Error('Invalid generated names');
  const scripts = await readBenchmarkScripts(get);
  if (scripts.some(row => values.includes(row.script_name) || (typeof row.service_name === 'string' && values.includes(row.service_name)))) throw Error('Worker name already exists');
  const namespaces = await allPages(get, '/workers/durable_objects/namespaces', LIMITS.namespaces, row => {
    if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{32}$/i.test(row.id) || typeof row.script !== 'string' || !row.script || typeof row.class !== 'string' || !row.class) throw Error('Unknown Durable Object namespace identity');
  }, row => row.id.toLowerCase());
  if (namespaces.some(row => values.includes(row.script))) throw Error('Namespace already exists');
  return { scriptCount: scripts.length, namespaceIds: namespaces.map(row => row.id) };
}
