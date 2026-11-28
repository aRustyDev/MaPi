// Use SQLite to convert integer columns to decimal text before crossing V8's
// number boundary. Nextgen stores Unix nanoseconds and requires exact int64s.
function columnPair(column) {
  return "CASE WHEN typeof(" + column + ") = 'integer' THEN printf('%lld', " + column +
    ") ELSE " + column + " END, typeof(" + column + ")";
}

// Wide results cannot use two result columns per value: workerd limits a
// result set to 100 columns. Prefix integers and text to distinguish them;
// retain blobs as blobs and real values as numbers. The common narrow path
// keeps its original representation and does not copy large text values.
function packedColumn(column) {
  const type = "typeof(" + column + ")";
  return "CASE WHEN " + type + " = 'integer' THEN 'i' || printf('%lld', " + column +
    ") WHEN " + type + " = 'text' THEN 't' || " + column + " ELSE " + column + " END";
}

function decodePacked(encoded) {
  if (typeof encoded === "string") {
    if (encoded[0] === "i") return { integer: encoded.slice(1) };
    if (encoded[0] === "t") return encoded.slice(1);
    throw new Error("Unexpected wide SQLite value tag");
  }
  if (encoded === null || typeof encoded === "number") return encoded;
  return { blob: new Uint8Array(encoded).toBase64() };
}

const sparseZeroNodeLimit = 2048;

// RETURNING cannot use a materialized CTE, and adding a type column per value
// can push a platform-valid returned row over SQLite's record-size limit.
// Integers use a minimal-width signed big-endian BLOB (zero uses an empty
// BLOB). Escape actual BLOBs only when their marker pattern can be confused
// with those reserved widths. Marker runs use compact tags when their suffix
// fits a supported encoding. TEXT is unchanged; other marker-heavy BLOBs can
// still exceed the limit.
// The compact wide codec keeps its tag in the existing BLOB escape grammar.
// JSON extraction maps each suffix byte to a Unicode code point; SQLite's
// unicode() returns NULL for a zero byte, which ifnull maps back to zero.
function compactValueExpression(column, length, marker) {
  const widths = "(0,1,2,3,4,6,8)";
  // Removing 9-byte markers preserves length modulo 9, so a remainder in a
  // reserved width already proves the original length has the same residue.
  const remainder = `length(CAST(replace(CAST(${column} AS TEXT),CAST(${marker} AS TEXT),'') AS BLOB))`;
  const byte = index => `ifnull(unicode(('"\\u00'||hex(substr(${column},${index},1))||'"')->>'$'),0)`;
  const run = n => `unhex(replace(hex(zeroblob(${n})),'00',hex(${marker})))`;
  const count = `${length}/9`, rem = `${length}%9`;
  // Sparse non-marker bytes (at most eight on this branch) leave at least
  // one of nine ASCII sentinels unused. Replace each marker by that byte;
  // the decoder expands it and copies every other byte verbatim.
  const stripped = `CAST(replace(CAST(${column} AS TEXT),CAST(${marker} AS TEXT),'') AS BLOB)`;
  const sentinels = 'ABCDEFGHI';
  const sentinel = `(CASE ${[...sentinels].map(c => `WHEN instr(${stripped},X'${c.charCodeAt(0).toString(16)}')=0 THEN '${c}'`).join(' ')} END)`;
  const sparse = `CAST(${marker}||'@MaPiRun1'||${sentinel}||replace(CAST(${column} AS TEXT),CAST(${marker} AS TEXT),${sentinel}) AS BLOB)`;
  // Reserve the sparse tag after any leading marker run (and literal Qs).
  // Its escaped form gets one extra marker; decodeReturning removes it.
  const sparseCollision = `substr(ltrim(replace(CAST(${column} AS TEXT),CAST(${marker} AS TEXT),'Q'),'Q'),1,9)='@MaPiRun1'`;
  // A reserved-tag source may itself be near the row-size limit. When the
  // span after its tag is zero-filled, preserve an arbitrary 64-byte tail and
  // encode the zero count instead of adding an escape marker to the full row.
  const headerEnd = `(instr(${column},X'404d61506952756e31')+8)`;
  const zeroCount = `(${length}-${headerEnd}-64)`;
  const zeroRun = `CAST(${marker}||'@MaPiRun1J'||unhex(printf('%08x',${zeroCount}))||substr(${column},1,${headerEnd})||substr(${column},-64) AS BLOB)`;
  // Traverse nonzero subranges, smallest first. Accept patches only from a
  // complete scan within the node budget and when they save space over escape.
  // The scan also bounds the number of leaves and the patch list size.
  // SQLite may evaluate this correlated subquery more than once per value.
  const partStart = `p+iif(side=0,0,n/2)`;
  const partLength = `iif(side=0,n/2,n-n/2)`;
  const sparseZero = `(WITH RECURSIVE mapi_zero_scan(p,n) AS MATERIALIZED (` +
    `SELECT 0,${zeroCount} UNION ALL SELECT ${partStart},${partLength} FROM mapi_zero_scan JOIN (SELECT 0 AS side UNION ALL SELECT 1) ` +
    `WHERE n>1 AND substr(${column},${headerEnd}+1+${partStart},${partLength})<>zeroblob(${partLength}) ORDER BY 2 ASC LIMIT ${sparseZeroNodeLimit}), ` +
    `mapi_zero_patches AS (SELECT p FROM mapi_zero_scan WHERE n=1) ` +
    `SELECT iif(count(*)>0 AND (SELECT count(*) FROM mapi_zero_scan)<${sparseZeroNodeLimit} AND ${zeroCount}>10*count(*)+18,CAST(${marker}||'@MaPiRun1K'||unhex(printf('%08x',${zeroCount}))||printf('%04X',count(*))||` +
    `group_concat(printf('%08X',p)||hex(substr(${column},${headerEnd}+1+p,1)),'')||substr(${column},1,${headerEnd})||substr(${column},-64) AS BLOB),` +
    `CAST(${marker}||${column} AS BLOB)) FROM mapi_zero_patches)`;
  const tag = `CAST(${marker}||unhex(printf('%02x',${count}>>8&255))||${run(`1+512*(${count}>>16)+256*(${rem} IN(3,8))+iif(${rem}=8,${byte(-8)},0)`)}||unhex(printf('%02x',${count}&255))||${run(`1+iif(${rem}=8,${byte(-7)},0)`)}||substr(${column},-min(${rem},6),${rem})||substr(X'53',1,${rem}=3) AS BLOB)`;
  // Count the hex digits needed for the signed value plus its sign bit,
  // then map byte widths 5 and 7 to the supported widths 6 and 8.
  const width = `substr('12346688',(length(printf('%x',(iif(${column}<0,~${column},${column})<<1)|1))+1)/2,1)`;
  return `CASE typeof(${column}) WHEN 'integer' THEN CASE WHEN ${column}=0 THEN X'' ELSE substr(unhex(printf('%016llx',${column})),9-(${width})) END` +
    ` WHEN 'blob' THEN iif(substr(${column},1,9)=${marker} AND ${sparseCollision},` +
    `iif(${zeroCount}>=64,iif(substr(${column},${headerEnd}+1,${zeroCount})=zeroblob(${zeroCount}),${zeroRun},${sparseZero}),CAST(${marker}||${column} AS BLOB)),` +
    `iif(${length} IN${widths} OR (substr(${column},1,9)=${marker} AND ${remainder} IN${widths}),` +
    `iif(${length}<75497472 AND substr(${column},-9-${length}%9,9)=${marker},${tag},` +
    `iif(${length}>100,${sparse},CAST(${marker}||${column} AS BLOB))),` +
    `${column})) ELSE ${column} END`;
}

function legacyReturningColumn(column, allowEight = true) {
  const length = `length(${column})`, marker = "X'FF0000000000000000'", widths = "(0,1,2,3,4,6,8)";
  // Removing 9-byte markers preserves length modulo 9, so the outer BLOB
  // collision check proves any eligible residue is a reserved width. Values
  // shorter than a marker cannot satisfy the later marker comparison.
  const remainder = `length(CAST(replace(CAST(${column} AS TEXT),CAST(${marker} AS TEXT),'') AS BLOB))`;
  // The eight-byte tag stores the first two suffix bytes in marker-run
  // lengths. Its remaining bytes plus the two count bytes have a reserved
  // width, so a source BLOB shaped like the tag is escaped as data.
  const byte = index => {
    const h = `hex(substr(${column},${index},1))`;
    return `(16*instr('0123456789ABCDEF',substr(${h},1,1))+instr('0123456789ABCDEF',substr(${h},2))-17)`;
  };
  const run = n => `unhex(replace(hex(zeroblob(${n})),'00','FF0000000000000000'))`;
  const count = `${length}/9`;
  const eightTag = `CAST(${marker}||unhex(printf('%02x',(${count}>>8)&255))||${run(`1+256*(${count}>>16)+${byte(-8)}`)}||unhex(printf('%02x',${count}&255))||${run(`1+${byte(-7)}`)}||substr(${column},-6) AS BLOB)`;
  const width = `CASE WHEN (${column}>>7) IN(-1,0) THEN 1 WHEN (${column}>>15) IN(-1,0) THEN 2 WHEN (${column}>>23) IN(-1,0) THEN 3 WHEN (${column}>>31) IN(-1,0) THEN 4 WHEN (${column}>>47) IN(-1,0) THEN 6 ELSE 8 END`;
  return `CASE typeof(${column}) WHEN 'integer' THEN CASE WHEN ${column}=0 THEN zeroblob(0) ELSE substr(unhex(printf('%016llx',${column})),9-(${width})) END` +
    ` WHEN 'blob' THEN CASE WHEN ${length} IN ${widths} OR (substr(${column},1,9)=${marker} AND ${remainder} IN ${widths}) THEN` +
    ` CASE WHEN ${length}/9<=8388607 AND ${allowEight ? '' : `${length}%9<>8 AND `}substr(${column},-9-${length}%9,9)=${marker} THEN ${allowEight ? `CASE WHEN ${length}%9=8 THEN ${eightTag} ELSE ` : ''}CAST(${marker}||unhex(printf('%04x',(${length}/9)&65535))||unhex(replace(hex(zeroblob(1+2*(${length}/9>>16)+(${length}%9=3))),'00','FF0000000000000000'))||substr(${column},-${length}%9,${length}%9)||CASE WHEN ${length}%9=3 THEN X'53' ELSE X'' END AS BLOB)${allowEight ? ' END' : ''} ELSE CAST(${marker}||${column} AS BLOB) END` +
    ` ELSE ${column} END ELSE ${column} END`;
}

// The scalar subquery gives each correlated RETURNING value short local names.
// For long identifiers, a nested alias avoids repeating the identifier; use
// whichever form keeps the complete projection shorter.
function compactReturningColumn(column) {
  const expression = compactValueExpression('v', 'l', 'm');
  const direct = `(SELECT ${expression} FROM (SELECT ${column} AS v,length(${column}) AS l,X'FF0000000000000000' AS m))`;
  const nested = `(SELECT ${expression} FROM (SELECT v,length(v) AS l,X'FF0000000000000000' AS m FROM (SELECT ${column} AS v)))`;
  return direct.length <= nested.length ? direct : nested;
}

// Reference one correlated encoder CTE from each result expression instead
// of repeating the full encoder. The name avoids all identifier-like tokens
// in the caller's SQL, including those in quoted text or comments.
function sharedReturningRewrite(sql, tokens, returningToken, columns) {
  const used = new Set((sql.match(/[a-zA-Z_][a-zA-Z_0-9$]*/g) || []).map(token => token.toLowerCase()));
  let name = 'mapi_shared_value';
  while (used.has(name)) name += '_';
  const helper = `${name} AS NOT MATERIALIZED (SELECT ${compactValueExpression('v', 'l', 'm')} AS e FROM (SELECT v,length(v) AS l,X'FF0000000000000000' AS m))`;
  const first = tokens.find(token => /^[A-Z_]/.test(token.word));
  let prefix;
  if (first?.word === 'WITH') {
    const next = tokens[tokens.indexOf(first) + 1];
    const position = next?.word === 'RECURSIVE' ? next.end : first.end;
    prefix = sql.slice(0, position) + ' ' + helper + ',' + sql.slice(position, returningToken.start) + 'RETURNING ';
  } else {
    prefix = 'WITH ' + helper + ' ' + sql.slice(0, returningToken.start) + 'RETURNING ';
  }
  return prefix + columns.map(column => `(SELECT (SELECT e FROM ${name}) FROM (SELECT ${column} AS v))`).join(', ');
}

// Last-resort wide codec: keep large non-colliding BLOBs unchanged and
// escape only values that collide with the reserved integer-width grammar.
function terseReturningColumn(column) {
  const marker = "X'4D615069233921403F'", widths = "(0,1,2,3,4,6,8)";
  const remainder = "length(CAST(replace(CAST(v AS TEXT),CAST(m AS TEXT),'') AS BLOB))";
  const width = "substr('12346688',(length(printf('%x',(iif(v<0,~v,v)<<1)|1))+1)/2,1)";
  const value = `CASE typeof(v) WHEN 'integer' THEN iif(v=0,X'',substr(unhex(printf('%016llx',v)),9-(${width}))) WHEN 'blob' THEN iif(l IN${widths} OR (substr(v,1,9)=m AND ${remainder} IN${widths}),CAST(m||v AS BLOB),v) ELSE v END`;
  const direct = `(SELECT ${value} FROM (SELECT ${column} AS v,length(${column}) AS l,${marker} AS m))`;
  const nested = `(SELECT ${value} FROM (SELECT v,length(v) AS l,${marker} AS m FROM (SELECT ${column} AS v)))`;
  return direct.length <= nested.length ? direct : nested;
}

const terseMarkerBytes = [77, 97, 80, 105, 35, 57, 33, 64, 63];

function decodeReturning(value, unified = false, terse = false) {
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  const blob = new Uint8Array(value);
  const widths = [0, 1, 2, 3, 4, 6, 8];
  if (widths.includes(blob.length)) {
    let integer = 0n;
    for (const byte of blob) integer = (integer << 8n) | BigInt(byte);
    if (blob.length && (blob[0] & 128)) integer -= 1n << BigInt(blob.length * 8);
    return { integer: integer.toString() };
  }
  const markerAt = index => {
    if (index + 9 > blob.length) return false;
    if (terse) {
      for (let i = 0; i < 9; i++) if (blob[index + i] !== terseMarkerBytes[i]) return false;
      return true;
    }
    if (blob[index] !== 255) return false;
    for (let i = 1; i < 9; i++) if (blob[index + i] !== 0) return false;
    return true;
  };
  // The selected SQL rewrite and decoder use the same transient tag format.
  if (unified) {
    if (markerAt(0)) {
      let markers = 0, position = 0;
      while (markerAt(position)) { markers++; position += 9; }
      while (blob[position] === 81) position++; // literal Q bytes
      const header = '@MaPiRun1';
      const hasHeader = [...header].every((c, i) => blob[position + i] === c.charCodeAt(0));
      if (hasHeader && markers > 1) return { blob: blob.subarray(9).toBase64() };
      if (hasHeader && markers === 1 && position === 9) {
        const sentinel = blob[position + header.length];
        if (sentinel === 75) {
          const start = position + header.length + 1;
          if (blob.length < start + 8 + 10 + 18 + 64) throw new Error('Invalid sparse-zero SQLite BLOB tag');
          const count = blob[start] * 0x1000000 + blob[start + 1] * 0x10000 + blob[start + 2] * 0x100 + blob[start + 3];
          const patchCount = String.fromCharCode(...blob.subarray(start + 4, start + 8));
          if (!/^[0-9A-F]{4}$/.test(patchCount)) throw new Error('Invalid sparse-zero SQLite BLOB patch count');
          const patches = Number.parseInt(patchCount, 16);
          if (count < 64 || patches < 1 || patches >= sparseZeroNodeLimit) throw new Error('Invalid sparse-zero SQLite BLOB length');
          const patchStart = start + 8, payloadStart = patchStart + patches * 10;
          if (blob.length < payloadStart + 18 + 64) throw new Error('Invalid sparse-zero SQLite BLOB payload');
          const payload = blob.subarray(payloadStart), prefixLength = payload.length - 64;
          const expanded = new Uint8Array(payload.length + count), seen = new Set();
          expanded.set(payload.subarray(0, prefixLength));
          expanded.set(payload.subarray(prefixLength), prefixLength + count);
          for (let i = 0; i < patches; i++) {
            const encoded = String.fromCharCode(...blob.subarray(patchStart + i * 10, patchStart + (i + 1) * 10));
            if (!/^[0-9A-F]{10}$/.test(encoded)) throw new Error('Invalid sparse-zero SQLite BLOB patch');
            const offset = Number.parseInt(encoded.slice(0, 8), 16), value = Number.parseInt(encoded.slice(8), 16);
            if (offset >= count || value === 0 || seen.has(offset)) throw new Error('Invalid sparse-zero SQLite BLOB patch');
            seen.add(offset);
            expanded[prefixLength + offset] = value;
          }
          return { blob: expanded.toBase64() };
        }
        if (sentinel === 74) {
          const start = position + header.length + 1;
          if (blob.length < start + 4 + 18 + 64) throw new Error('Invalid zero-run SQLite BLOB tag');
          const count = blob[start] * 0x1000000 + blob[start + 1] * 0x10000 + blob[start + 2] * 0x100 + blob[start + 3];
          if (count < 64) throw new Error('Invalid zero-run SQLite BLOB length');
          const payload = blob.subarray(start + 4);
          const prefixLength = payload.length - 64;
          const expanded = new Uint8Array(payload.length + count);
          expanded.set(payload.subarray(0, prefixLength));
          expanded.set(payload.subarray(prefixLength), prefixLength + count);
          return { blob: expanded.toBase64() };
        }
        if (sentinel < 65 || sentinel > 73) throw new Error('Invalid sparse SQLite BLOB sentinel');
        const payload = blob.subarray(position + header.length + 1);
        let markerCount = 0;
        for (const byte of payload) if (byte === sentinel) markerCount++;
        const expanded = new Uint8Array(payload.length + markerCount * 8);
        let out = 0;
        for (const byte of payload) {
          if (byte === sentinel) { expanded[out] = 255; out += 9; }
          else expanded[out++] = byte;
        }
        return { blob: expanded.toBase64() };
      }
    }
    // Two bounded marker runs encode the high count, suffix bytes and flag.
    // Their separators ensure an unprefixed tag cannot begin with a marker;
    // a source BLOB shaped like a tag is escaped as ordinary data.
    if (markerAt(0) && markerAt(10)) {
      let position = 10, first = 0;
      while (first < 65536 && markerAt(position)) { position += 9; first++; }
      const low = blob[position++];
      let second = 0;
      while (second < 256 && markerAt(position)) { position += 9; second++; }
      const meta = first - 1, flag = (meta & 256) !== 0;
      const count = Math.floor(meta / 512) * 65536 + blob[9] * 256 + low;
      const remaining = blob.length - position;
      const valid = flag ? (remaining === 4 && blob[blob.length - 1] === 83 && (meta & 255) === 0 && second === 1) || remaining === 6 : (meta & 255) === 0 && second === 1 && [0,1,2,4,6].includes(remaining);
      if (first > 0 && second > 0 && count > 0 && valid) {
        const tail = flag && remaining === 4 ? 3 : flag && remaining === 6 ? 8 : remaining;
        const repeated = new Uint8Array(count * 9 + tail);
        for (let i = 0; i < count * 9; i += 9) repeated[i] = 255;
        if (tail === 8) {
          repeated[count * 9] = meta & 255;
          repeated[count * 9 + 1] = second - 1;
          repeated.set(blob.subarray(position), count * 9 + 2);
        } else {
          repeated.set(blob.subarray(position, position + tail), count * 9);
        }
        return { blob: repeated.toBase64() };
      }
    }
  } else if (!terse) {
    // In this tag each count byte precedes a marker run, so the bytes after
    // the first marker cannot themselves start with a marker (FF is followed
    // by the next marker's FF). The two runs encode the high count and suffix.
    if (markerAt(0) && markerAt(10)) {
      let position = 10, first = 0;
      while (first < 32768 && markerAt(position)) { position += 9; first++; }
      const low = blob[position++];
      let second = 0;
      while (second < 256 && markerAt(position)) { position += 9; second++; }
      const count = Math.floor((first - 1) / 256) * 65536 + blob[9] * 256 + low;
      if (first > 0 && second > 0 && position + 6 === blob.length && count > 0) {
        const repeated = new Uint8Array(count * 9 + 8);
        for (let i = 0; i < count * 9; i += 9) repeated[i] = 255;
        repeated[count * 9] = (first - 1) % 256;
        repeated[count * 9 + 1] = second - 1;
        repeated.set(blob.subarray(position), count * 9 + 2);
        return { blob: repeated.toBase64() };
      }
    }
    // A compact tag is marker + two low count bytes + one or more markers
    // encoding the high count and padding flag, followed by the tail. After
    // the first marker the count bytes cannot begin a marker: FF 00 would be
    // followed by the FF at the start of the next marker. A source BLOB shaped
    // like this tag is escaped as data because its remainder has a reserved
    // integer width.
    if (markerAt(0) && markerAt(11)) {
      let position = 11, markers = 0;
      while (markerAt(position) && markers < 257) { markers++; position += 9; }
      // Odd marker counts carry a normal tail; even counts carry a padded
      // three-byte tail. Limit the encoded high count to 23 bits.
      const tailBytes = blob.length - position;
      const flag = (markers - 1) % 2;
      const count = Math.floor((markers - 1) / 2) * 65536 + blob[9] * 256 + blob[10];
      if (markers <= 256 && count > 0 && ((tailBytes === 4 && (!flag || blob[blob.length - 1] === 83)) || (!flag && [0,1,2,6].includes(tailBytes)))) {
        const tail = tailBytes - flag;
        const repeated = new Uint8Array(count * 9 + tail);
        for (let i = 0; i < count * 9; i += 9) repeated[i] = 255;
        repeated.set(blob.subarray(position, position + tail), count * 9);
        return { blob: repeated.toBase64() };
      }
    }
  }
  let escaped = blob.length >= 9 && widths.includes(blob.length % 9) && markerAt(0);
  if (escaped) {
    let position = 0, remainder = 0;
    while (position < blob.length && remainder <= 8) {
      if (markerAt(position)) position += 9;
      else { position++; remainder++; }
    }
    escaped = position === blob.length && widths.includes(remainder);
  }
  return { blob: (escaped ? blob.subarray(9) : blob).toBase64() };
}

function bind(statement, args) {
  let highest = 0;
  const sql = statement.replace(/'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\?(\d*)/g, (part, numbered) => {
    // SQLite accepts a trailing block comment without its closing delimiter.
    // Remove only that comment: query-mode appends wrapper SQL after the
    // original statement, which would otherwise remain inside the comment.
    if (numbered === undefined) return part.startsWith('/*') && (part.length < 4 || !part.endsWith('*/')) ? ' ' : part;
    const index = numbered === "" ? highest + 1 : Number(numbered);
    // SQLite Durable Objects support at most 100 bound parameters.
    if (!Number.isSafeInteger(index) || index < 1 || index > 100) throw new Error("Invalid SQLite parameter index");
    highest = Math.max(highest, index);
    if (index > args.length) throw new Error("Missing SQLite argument");
    const placeholder = `?${index}`;
    return args[index - 1].kind === "int" ? `CAST(${placeholder} AS INTEGER)` : placeholder;
  });
  if (highest !== args.length) throw new Error("SQLite argument count mismatch");
  const realValues = { inf: Infinity, "-inf": -Infinity, "-0": -0 };
  const values = args.map(({ kind, value }) => {
    if (kind === "blob") return Uint8Array.fromBase64(value).buffer;
    if (kind === "real") {
      if (typeof value !== "string" || !Object.hasOwn(realValues, value)) throw new Error("Invalid SQLite REAL argument");
      return realValues[value];
    }
    return value;
  });
  return { sql, values };
}

function decodePair(value, type) {
  if (type === "integer") return { integer: value };
  if (type === "blob") return { blob: new Uint8Array(value).toBase64() };
  return value;
}

// Only inspect tokens outside quoted strings, identifiers and comments.
// A SQL exec can contain more than one statement, so query-mode callers must
// not be allowed to hide a write after a leading SELECT.
function queryTokens(statement) {
  let depth = 0;
  const found = [];
  const tokens = /'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[();,]|[a-zA-Z_\u0080-\u{10ffff}][a-zA-Z_0-9$\u0080-\u{10ffff}]*/gu;
  for (const match of statement.matchAll(tokens)) {
    const token = match[0];
    if (token === "(") {
      if (depth === 0) found.push({ word: token, start: match.index, end: match.index + 1 });
      depth++; continue;
    }
    if (token === ")") {
      depth--;
      if (depth === 0) found.push({ word: token, start: match.index, end: match.index + 1 });
      continue;
    }
    // SQLite keywords are ASCII case-insensitive; Unicode case folding can
    // turn an identifier such as "aſ" into the keyword "AS".
    if (depth === 0 && (/^[a-zA-Z_]/.test(token) || token === ";" || token === ",")) found.push({ word: token.replace(/[a-z]/g, character => character.toUpperCase()), start: match.index, end: match.index + token.length });
  }
  return found;
}

function singleQueryStatement(statement) {
  const tokens = queryTokens(statement);
  const semicolons = tokens.filter(token => token.word === ";");
  if (semicolons.length > 1) throw new Error("Multiple SQLite statements are unsupported in query mode");
  if (!semicolons.length) return statement;
  const trailing = statement.slice(semicolons[0].end);
  if (!/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(trailing)) throw new Error("Multiple SQLite statements are unsupported in query mode");
  return statement.slice(0, semicolons[0].start);
}

function queryVerb(tokens) {
  const first = tokens.find(token => /^[A-Z_]/.test(token.word));
  if (!first || first.word !== "WITH") return first;
  // Skip complete CTE definitions, including optional column lists and
  // MATERIALIZED modifiers, before deciding whether the main query writes.
  // A valid CTE can itself be named REPLACE or UPDATE.
  let index = tokens.indexOf(first) + 1;
  while (index < tokens.length) {
    while (index < tokens.length && tokens[index].word !== "AS") index++;
    if (index === tokens.length) return undefined;
    index++;
    while (index < tokens.length && tokens[index].word !== "(") index++;
    if (index === tokens.length) return undefined;
    index++;
    while (index < tokens.length && tokens[index].word !== ")") index++;
    if (index === tokens.length) return undefined;
    index++;
    if (tokens[index]?.word === ",") { index++; continue; }
    const verb = tokens[index];
    return verb && ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"].includes(verb.word) ? verb : undefined;
  }
  return undefined;
}

// Discover the original column names without stepping any result row. A
// direct sql.exec() steps the first row even before its cursor is consumed.
// Preserve LIMIT/OFFSET placeholders inside unreachable CASE branches, so
// SQLite accepts the same bindings without evaluating volatile expressions.
function metadataQuery(statement, tokens, verb) {
  const limit = tokens.find(token => token.start > verb.end && token.word === "LIMIT");
  if (!limit) return statement + "\nLIMIT 0";
  const separator = tokens.find(token => token.start > limit.end && (token.word === "OFFSET" || token.word === ","));
  const zero = expression => " CASE WHEN 0 THEN (\n" + expression + "\n) ELSE 0 END";
  if (!separator) return statement.slice(0, limit.end) + zero(statement.slice(limit.end));
  return statement.slice(0, limit.end) + zero(statement.slice(limit.end, separator.start)) +
    " " + statement.slice(separator.start, separator.end) + zero(statement.slice(separator.end));
}

// Comments in a RETURNING projection are whitespace, not column names.
// Preserve quoted tokens so the existing simple-identifier restriction cannot
// accidentally treat an expression or quoted identifier as a plain name.
function returningProjection(statement) {
  return statement.replace(/'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?\*\//g, part =>
    part.startsWith('--') || part.startsWith('/*') ? ' ' : part);
}

// Migration 33's six-arm search backfill exceeds workerd's compound SELECT
// limit. Nesting two groups preserves UNION ALL and keeps each group bounded.
function adaptSearchEntriesMigration(statement) {
  const prefix = "names(project_id, kind, key, resource_id, title, subtitle, name) AS (";
  if (!statement.includes(prefix) || !statement.includes("INSERT OR IGNORE INTO search_entries")) return statement;
  const start = statement.indexOf(prefix) + prefix.length;
  const end = statement.indexOf("\n),\nfolded AS (", start);
  if (end < 0) throw new Error("Unexpected search entries migration shape");
  const arms = statement.slice(start, end).split(/\n\s*UNION ALL\s*\n/);
  if (arms.length !== 6) throw new Error("Unexpected search entries migration UNION count");
  const first = arms.slice(0, 3).join("\nUNION ALL\n");
  const second = arms.slice(3).join("\nUNION ALL\n");
  return statement.slice(0, start) + "\nSELECT * FROM (" + first + ")\nUNION ALL\nSELECT * FROM (" + second + ")" + statement.slice(end);
}

export function execute(storage, { statement, args, query }) {
  statement = adaptSearchEntriesMigration(statement);
  const bound = bind(statement, args);
  const values = bound.values;
  const sql = query ? singleQueryStatement(bound.sql) : bound.sql;
  if (!query) {
    const cursor = storage.sql.exec(sql, ...values);
    cursor.toArray();
    // rowsWritten is a billing counter that also includes index writes.
    // database/sql requires SQLite's logical affected-row count instead.
    const changes = storage.sql.exec("SELECT changes() AS count").one().count;
    return { changes };
  }

  const tokens = queryTokens(sql);
  const verb = queryVerb(tokens);
  const kind = verb?.word ?? "";
  const returningToken = ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(kind) ? tokens.find(token => token.start > verb.end && token.word === "RETURNING") : undefined;
  const returning = returningToken ? /^\s*([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*$/i.exec(returningProjection(sql.slice(returningToken.end))) : null;
  let columns;
  let prepared;
  let wide;
  const isReturning = !!returning;
  let unified = false;
  let terse = false;
  if (returning) {
    columns = returning[1].split(/\s*,\s*/);
    wide = columns.length > 50;
    // Use the compact codec for wide projections. When the rewritten SQL is
    // too large, share the compact encoder before trying shorter prior codecs.
    const prefix = sql.slice(0, returningToken.start) + "RETURNING ";
    unified = wide;
    prepared = prefix + columns.map(column => wide ? compactReturningColumn(column) : legacyReturningColumn(column)).join(", ");
    if (wide && new TextEncoder().encode(prepared).length > 100000) {
      const candidate = sharedReturningRewrite(sql, tokens, returningToken, columns);
      if (new TextEncoder().encode(candidate).length < new TextEncoder().encode(prepared).length) {
        unified = true;
        prepared = candidate;
      }
    }
    if (wide && new TextEncoder().encode(prepared).length > 100000) {
      const shorter = prefix + columns.map(column => legacyReturningColumn(column, false)).join(", ");
      if (new TextEncoder().encode(shorter).length < new TextEncoder().encode(prepared).length) {
        unified = false;
        prepared = shorter;
      }
    }
    if (wide && new TextEncoder().encode(prepared).length > 100000) {
      const fallback = prefix + columns.map(column => terseReturningColumn(column)).join(", ");
      if (new TextEncoder().encode(fallback).length < new TextEncoder().encode(prepared).length) {
        unified = false;
        terse = true;
        prepared = fallback;
      }
    }
  } else {
    if (kind !== "SELECT") throw new Error("Unsupported row-producing SQLite statement");
    const cursor = storage.sql.exec(metadataQuery(sql, tokens, verb), ...values);
    columns = cursor.columnNames;
    // Drain the zero-row cursor so it cannot retain a lock across later DDL.
    for (const _row of cursor.raw()) { /* Exhaust the cursor without retaining rows. */ }
    const aliases = columns.map((_column, index) => "column_" + index);
    wide = columns.length > 50;
    // Avoid shadowing a real table or CTE named mapi_rows in the source.
    let rowSource = "mapi_rows";
    while (new RegExp("\\b" + rowSource + "\\b", "i").test(sql)) rowSource += "_";
    prepared = "WITH " + rowSource + "(" + aliases.join(", ") + ") AS MATERIALIZED (" + sql.trim() +
      "\n) SELECT " + aliases.map(wide ? packedColumn : columnPair).join(", ") + " FROM " + rowSource;
  }
  const rows = storage.sql.exec(prepared, ...values).raw().toArray().map((row) =>
    columns.map((_column, index) => isReturning ? decodeReturning(row[index], unified, terse) : wide ? decodePacked(row[index]) : decodePair(row[index * 2], row[index * 2 + 1])));
  return { columns, rows };
}

// Preserve REAL values JSON would otherwise turn into null or positive zero.
export function stringifySQLResponse(response) {
  const needsTag = value => value === Infinity || value === -Infinity || Object.is(value, -0);
  if (!response.rows?.some(row => row.some(needsTag))) return JSON.stringify(response);

  return JSON.stringify(response, (_key, value) => {
    if (value === Infinity) return { real: "inf" };
    if (value === -Infinity) return { real: "-inf" };
    if (Object.is(value, -0)) return { real: "-0" };
    return value;
  });
}

export function sqliteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const codes = [
    [/UNIQUE constraint failed/, 2067], [/FOREIGN KEY constraint failed/, 787],
    [/NOT NULL constraint failed/, 1299], [/CHECK constraint failed/, 275],
  ];
  return { message, code: codes.find(([match]) => match.test(message))?.[1] ?? 0 };
}
