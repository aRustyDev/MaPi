// JSON.parse silently keeps the last duplicate member. For an external recovery
// era map that could select an unintended era, so reject duplicate *decoded*
// object IDs before accepting the map. Values must be strings, as below.
function parseEpochMap(raw) {
  let position = 0;
  const whitespace = () => { while (position < raw.length && /[\x20\t\r\n]/.test(raw[position])) position++; };
  const take = (character) => {
    whitespace();
    if (raw[position++] !== character) throw new Error('Invalid recovery epoch configuration');
  };
  const takeString = () => {
    whitespace();
    const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    string.lastIndex = position;
    const match = string.exec(raw);
    if (!match) throw new Error('Invalid recovery epoch configuration');
    position = string.lastIndex;
    return JSON.parse(match[0]);
  };
  const keys = new Set();
  take('{');
  whitespace();
  if (raw[position] !== '}') {
    while (true) {
      const key = takeString();
      if (keys.has(key)) throw new Error('Invalid recovery epoch configuration');
      keys.add(key);
      take(':');
      takeString();
      whitespace();
      if (raw[position] !== ',') break;
      position++;
    }
  }
  take('}');
  whitespace();
  if (position !== raw.length) throw new Error('Invalid recovery epoch configuration');
  return JSON.parse(raw);
}

// TextEncoder and SQLite bindings may replace isolated UTF-16 surrogates with
// U+FFFD. Distinct configured eras must not collapse to the same stored bytes.
function wellFormedEpoch(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function recoveryEpochConfiguration(env) {
  const target = env.MAPI_RECOVERY_TARGET_OBJECT;
  const raw = env.MAPI_RECOVERY_OBJECT_EPOCHS;
  if (target === undefined && raw === undefined) return null;
  if (typeof target !== 'string' || !/^[0-9a-f]{64}$/.test(target) || typeof raw !== 'string') throw new Error('Invalid recovery epoch configuration');
  let epochs;
  try { epochs = parseEpochMap(raw); } catch { throw new Error('Invalid recovery epoch configuration'); }
  if (!epochs || typeof epochs !== 'object' || Array.isArray(epochs) || !Object.hasOwn(epochs, target)) throw new Error('Invalid recovery epoch configuration');
  for (const [objectId, epoch] of Object.entries(epochs)) {
    if (!/^[0-9a-f]{64}$/.test(objectId) || typeof epoch !== 'string' || !epoch || epoch === '0' || !wellFormedEpoch(epoch) || new TextEncoder().encode(epoch).length > 128) throw new Error('Invalid recovery epoch configuration');
  }
  return epochs;
}
