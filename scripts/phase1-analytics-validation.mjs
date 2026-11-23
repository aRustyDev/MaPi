// Validate and project only the fields requested by the analytics collector.
// A valid page is still sampled and is not proof of a complete time window.
const LIMIT = 10000;

export function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fractional = '') => `.${fractional.padEnd(3, '0')}Z`);
  return new Date(time).toISOString() === normalized ? time : NaN;
}

function metric(object, name, integer = false) {
  const value = object?.[name];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid analytics ${name}`);
  }
  return value;
}

export function validateAnalyticsGroups(data, namespaceId, objectId, start, end) {
  const accounts = data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0] || typeof accounts[0] !== 'object') {
    throw new Error('Invalid analytics account result');
  }
  const result = accounts[0];
  const validate = (items, periodic) => {
    if (!Array.isArray(items) || items.length > LIMIT) throw new Error('Invalid analytics groups');
    return items.map(item => {
      const dim = item?.dimensions;
      const time = utcMillis(dim?.datetime);
      if (!Number.isFinite(time) || time < start || time >= end ||
          typeof dim.namespaceId !== 'string' || dim.namespaceId.toLowerCase() !== namespaceId.toLowerCase() ||
          typeof dim.objectId !== 'string' || dim.objectId.toLowerCase() !== objectId.toLowerCase()) {
        throw new Error('Analytics group outside requested scope');
      }
      const dimensions = { datetime: dim.datetime, objectId: dim.objectId, namespaceId: dim.namespaceId };
      if (periodic) {
        return { count: metric(item, 'count', true), dimensions,
          sum: { cpuTime: metric(item.sum, 'cpuTime'), exceededCpuErrors: metric(item.sum, 'exceededCpuErrors', true), exceededMemoryErrors: metric(item.sum, 'exceededMemoryErrors', true) },
          max: { memoryUsageBytes: metric(item.max, 'memoryUsageBytes', true) } };
      }
      if (typeof dim.status !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(dim.status)) throw new Error('Invalid analytics status');
      dimensions.status = dim.status;
      return { dimensions, sum: { requests: metric(item.sum, 'requests', true), errors: metric(item.sum, 'errors', true), wallTime: metric(item.sum, 'wallTime') } };
    });
  };
  const periodic = validate(result.durableObjectsPeriodicGroups, true);
  const invocations = validate(result.durableObjectsInvocationsAdaptiveGroups, false);
  return { objectId, periodic, invocations, atResultLimit: { periodic: periodic.length === LIMIT, invocations: invocations.length === LIMIT } };
}
