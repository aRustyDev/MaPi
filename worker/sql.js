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

function jsonBlob(bytes) {
  return { blob: bytes.toBase64() };
}

function decodePacked(encoded, formatBlob) {
  if (typeof encoded === "string") {
    if (encoded[0] === "i") return { integer: encoded.slice(1) };
    if (encoded[0] === "t") return encoded.slice(1);
    throw new Error("Unexpected wide SQLite value tag");
  }
  if (encoded === null || typeof encoded === "number") return encoded;
  return formatBlob(new Uint8Array(encoded));
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

function decodeReturning(value, unified = false, terse = false, formatBlob = jsonBlob) {
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
      if (hasHeader && markers > 1) return formatBlob(blob.subarray(9));
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
          return formatBlob(expanded);
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
          return formatBlob(expanded);
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
        return formatBlob(expanded);
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
        return formatBlob(repeated);
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
        return formatBlob(repeated);
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
        return formatBlob(repeated);
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
  return formatBlob(escaped ? blob.subarray(9) : blob);
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
  const values = args.map(({ kind, value }) => kind === "blob" ? Uint8Array.fromBase64(value).buffer : value);
  return { sql, values };
}

function decodePair(value, type, formatBlob) {
  if (type === "integer") return { integer: value };
  if (type === "blob") return formatBlob(new Uint8Array(value));
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

// Returning mutations share 4 MiB of logical payload across at most 64
// selected rows. SELECT uses a co-routine source with the same per-row ceiling.
// The Go receiver caps each snapshot and all outstanding snapshots.
const resultPayloadBytes = 4 * 1024 * 1024;
const maxReturningRows = 64;
const maxSelectRows = 4096;
const maxColumnNameBytes = 128 * 1024;
const resultSizePath = "$mapi_result_bytes";
const exactTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A single output cell carries its type without inspecting an imprecise JS
// number. TEXT and BLOB are disjoint tagged byte sequences, INTEGER is
// decimal text, and only SQLite REAL crosses the bridge as a JS number.
function boundedColumn(name) {
  return `(SELECT CASE typeof(v) WHEN 'integer' THEN printf('%lld',v)` +
    ` WHEN 'text' THEN CAST(X'54'||v AS BLOB) WHEN 'blob' THEN CAST(X'42'||v AS BLOB)` +
    ` ELSE v END FROM (SELECT ${name} AS v))`;
}

function boundedProjection(columns, limit) {
  const encoded = columns.map(boundedColumn);
  // Group additions so a wide projection fits SQLite's expression-depth limit.
  const groups = [];
  for (let i = 0; i < columns.length; i += 10) {
    groups.push("(" + columns.slice(i, i + 10).map(name => `coalesce(length(CAST(${name} AS BLOB)),0)`).join("+") + ")");
  }
  encoded[0] = `CASE WHEN ${groups.join("+")}>${limit} THEN json_extract('{}','${resultSizePath}') ELSE ${encoded[0]} END`;
  return encoded.join(", ");
}

function decodeBounded(value) {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "string") return { integer: value };
  const bytes = new Uint8Array(value);
  if (bytes[0] === 66) return bytes.subarray(1);
  if (bytes[0] === 84) return exactTextDecoder.decode(bytes.subarray(1));
  throw new Error("Invalid MaPi SQLite result type");
}

function resultColumnNames(columns) {
  if (!columns.length || columns.length > 100 ||
      columns.reduce((total, name) => total + frameEncoder.encode(name).length, 0) > maxColumnNameBytes) {
    throw new Error("MaPi SQLite result column metadata limit exceeded");
  }
}

function returningInsertRows(sql, tokens, verb, returningToken) {
  const source = tokens.filter(token => token.start > verb.end && token.start < returningToken.start);
  const values = source.findIndex(token => token.word === "VALUES" || token.word === "SELECT");
  if (source[values]?.word !== "VALUES") {
    // The pinned password insert uses an ungrouped aggregate. It emits one
    // row even when there is no password history and takes the write lock
    // before reading that history.
    const normalized = returningProjection(sql.slice(verb.start, returningToken.start))
      .toLowerCase().replace(/cast\(\?(\d+) as integer\)/g, "?$1").replace(/\s+/g, " ").trim();
    if (normalized === "insert into user_passwords ( project_id, id, user_id, encoded_hash, created_at ) select ?1, ?2, ?3, ?4, max(?5, ifnull(max(created_at) + 1000, 0)) from user_passwords where project_id = ?6 and user_id = ?7") return 1;
    throw new Error("MaPi SQLite RETURNING requires an admitted INSERT source");
  }
  if (source[values - 1]?.word === "DEFAULT") return 1;
  let i = values + 1;
  let rows = 0;
  while (source[i]?.word === "(" && source[i + 1]?.word === ")") {
    rows++;
    i += 2;
    if (source[i]?.word !== ",") break;
    i++;
  }
  if (!rows || (source[i] && source[i].word !== "ON")) {
    throw new Error("MaPi SQLite RETURNING requires a finite VALUES list");
  }
  if (rows > maxReturningRows) throw new Error("MaPi SQLite RETURNING row limit exceeded");
  return rows;
}

// Capture the actual candidate rowids once inside the write transaction.
// The mutation can affect only those identities, including when a predicate
// is volatile or a trigger changes whether other rows match it.
function boundedReturningTargets(storage, sql, tokens, verb, returningToken, values) {
  const prefix = sql.slice(verb.start, returningToken.start);
  const target = (verb.word === "DELETE" ? /^DELETE\s+FROM\s+([a-z_]\w*)\b/di : /^UPDATE\s+([a-z_]\w*)\s+SET\b/di).exec(prefix);
  const inner = tokens.filter(token => token.start >= verb.start + (target?.[0].length ?? 0) && token.start < returningToken.start);
  const where = inner.find(token => token.word === "WHERE");
  if (!target || inner.some(token => token.word === "FROM" || token.word === "ORDER" || token.word === "LIMIT")) {
    throw new Error("MaPi SQLite RETURNING requires a simple rowid mutation");
  }
  if (verb.word === "DELETE" && returningProjection(sql.slice(verb.start + target[0].length, where?.start ?? returningToken.start)).trim()) {
    throw new Error("MaPi SQLite RETURNING requires an unqualified DELETE target");
  }
  const name = target[1];
  const table = `main."${name}"`;
  const tables = storage.sql.exec("SELECT sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE AND type='table'", name).toArray();
  if (tables.length !== 1 || !/^CREATE TABLE\b/i.test(tables[0].sql) ||
      storage.sql.exec(`PRAGMA main.table_xinfo("${name}")`).toArray().some(column => column.name.toLowerCase() === "_rowid_")) {
    throw new Error("MaPi SQLite RETURNING requires an unshadowed rowid");
  }
  const predicate = where ? sql.slice(where.end, returningToken.start) : "1";
  // Retain the original numbered-parameter count without evaluating any
  // parameters removed from the preflight query or rewritten mutation.
  const preserveBindings = values.length ? ` AND CASE WHEN 0 THEN ?${values.length} ELSE 1 END` : "";
  const rows = storage.sql.exec(`SELECT printf('%lld',_rowid_) FROM ${table} WHERE (${predicate}
)${preserveBindings} LIMIT ${maxReturningRows + 1}`, ...values).raw().toArray();
  if (rows.length > maxReturningRows) throw new Error("MaPi SQLite RETURNING row limit exceeded");
  const ids = rows.map(([id]) => {
    if (!/^-?\d+$/.test(id)) throw new Error("Invalid MaPi SQLite rowid");
    return id;
  });
  const [start, end] = target.indices[1].map(index => index + verb.start);
  const write = sql.slice(0, start) + table + sql.slice(end, where?.start ?? returningToken.start);
  return { rows: rows.length, prefix: `${write}
 WHERE _rowid_ IN (${ids.join(",")})${preserveBindings} RETURNING ` };
}

function streamBounded(storage, statement, values, columns, rowLimit, sink) {
  if (frameEncoder.encode(statement).length > 100_000) throw new Error("MaPi SQLite rewritten statement exceeds SQL byte limit");
  const cursor = storage.sql.exec(statement, ...values);
  const raw = cursor.raw();
  let frameRows = 0;
  try {
    for (const row of raw) {
      if (++frameRows > rowLimit) throw new Error("MaPi SQLite result row limit exceeded");
      sink.writeRow(row.map(decodeBounded));
    }
    sink.finish();
    return { columns, frameRows };
  } catch (error) {
    // Older workerd runtimes expose only draining. The SQL statement itself
    // bounds the number of additional rows that may be drained.
    try {
      if (typeof cursor.close === "function") cursor.close();
      else for (const _row of raw) { /* Discard pending rows. */ }
    } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function executeBounded(storage, sql, values, tokens, verb, returningToken, returning, sink) {
  if (returning) {
    const columns = returning[1].split(/\s*,\s*/);
    resultColumnNames(columns);
    if (tokens[0] !== verb) throw new Error("MaPi SQLite RETURNING requires a direct mutation");
    return storage.transactionSync(() => {
      let prefix, rows;
      if (verb.word === "INSERT" || verb.word === "REPLACE") {
        rows = returningInsertRows(sql, tokens, verb, returningToken);
        prefix = sql.slice(0, returningToken.start) + "RETURNING ";
      } else {
        ({ rows, prefix } = boundedReturningTargets(storage, sql, tokens, verb, returningToken, values));
      }
      const limit = Math.floor(resultPayloadBytes / Math.max(rows, 1));
      return streamBounded(storage, prefix + boundedProjection(columns, limit), values, columns, rows, sink);
    });
  }
  if (verb?.word !== "SELECT") throw new Error("Unsupported row-producing SQLite statement");

  const metadata = storage.sql.exec(metadataQuery(sql, tokens, verb), ...values);
  const columns = metadata.columnNames;
  for (const _row of metadata.raw()) { /* Release the zero-row cursor. */ }
  resultColumnNames(columns);
  const aliases = columns.map((_column, i) => "column_" + i);
  let source = "mapi_rows";
  while (new RegExp("\\b" + source + "\\b", "i").test(sql)) source += "_";

  // OFFSET keeps SQLite from flattening the source into its outer typed
  // projection. The source is scanned once and never materialized just to
  // encode it. The extra row reports exhaustion without truncating the result.
  const prepared = `WITH ${source}(${aliases.join(", ")}) AS NOT MATERIALIZED (` +
    `SELECT * FROM (
${sql.trim()}
) LIMIT -1 OFFSET 0) SELECT ` +
    boundedProjection(aliases, resultPayloadBytes) + ` FROM ${source} LIMIT ${maxSelectRows + 1}`;
  return streamBounded(storage, prepared, values, columns, maxSelectRows, sink);
}

export function execute(storage, { statement, args, query }, resultSink) {
  statement = adaptSearchEntriesMigration(statement);
  const bound = bind(statement, args);
  const values = bound.values;
  const sql = query ? singleQueryStatement(bound.sql) : bound.sql;
  if (!query) {
    if (resultSink === null) {
      const tokens = queryTokens(sql);
      if (tokens.some(token => token.word === "RETURNING")) throw new Error("MaPi SQLite RETURNING requires query mode");
      if (["SELECT", "VALUES", "EXPLAIN"].includes(queryVerb(tokens)?.word)) {
        throw new Error("MaPi SQLite reads require query mode");
      }
    }
    const cursor = storage.sql.exec(sql, ...values);
    if (resultSink === null) {
      for (const _row of cursor.raw()) { /* Exec callers discard result rows. */ }
    } else cursor.toArray();
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
  if (resultSink) {
    return executeBounded(storage, sql, values, tokens, verb, returningToken, returning, resultSink);
  }
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
  const rows = storage.sql.exec(prepared, ...values).raw().toArray().map(row =>
    columns.map((_column, index) => {
      if (isReturning) return decodeReturning(row[index], unified, terse);
      if (wide) return decodePacked(row[index], jsonBlob);
      return decodePair(row[index * 2], row[index * 2 + 1], jsonBlob);
    }));
  return { columns, rows };
}

export function sqliteError(error) {
  let message = error instanceof Error ? error.message : String(error);
  if (message.includes(resultSizePath) && /json path/i.test(message)) message = "MaPi SQLite result row byte limit exceeded";
  const codes = [
    [/UNIQUE constraint failed/, 2067], [/FOREIGN KEY constraint failed/, 787],
    [/NOT NULL constraint failed/, 1299], [/CHECK constraint failed/, 275],
    [/MaPi SQLite (?:result|RETURNING).*limit exceeded/, 18],
  ];
  return { message, code: codes.find(([match]) => match.test(message))?.[1] ?? 0 };
}

const frameEncoder = new TextEncoder();
const frameDecoder = new TextDecoder();
const frameBytes = 32 * 1024;

// The receiver supplies a reusable scratch region. Go callbacks may grow its
// memory, so every flush invalidates the JavaScript view of that region.
function resultSink(memory, receiveFrame, pointer) {
  let bytes = new Uint8Array(memory(), pointer, frameBytes);
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let used = 0;

  function flush() {
    if (!used) return;
    const status = receiveFrame(pointer, used);
    if (status === 2) throw new Error("MaPi SQLite result snapshot byte limit exceeded");
    if (status !== 0) throw new Error("SQLite result frame was rejected");
    used = 0;
    bytes = new Uint8Array(memory(), pointer, frameBytes);
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function reserve(size) {
    if (used + size > bytes.length) flush();
    const start = used;
    used += size;
    return start;
  }

  function writeText(value) {
    // Each UTF-8 segment has a little-endian uint16 byte length. A zero
    // length terminates the cell. Do not split a UTF-16 surrogate pair.
    for (let offset = 0; offset < value.length;) {
      if (bytes.length - used < 6) flush();
      const start = used + 2;
      let end = Math.min(value.length, offset + bytes.length - start);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      const { read, written } = frameEncoder.encodeInto(value.slice(offset, end), bytes.subarray(start));
      view.setUint16(used, written, true);
      used = start + written;
      offset += read;
    }
    const end = reserve(2);
    view.setUint16(end, 0, true);
  }

  function writeBlob(value) {
    const lengthOffset = reserve(4);
    view.setUint32(lengthOffset, value.length, true);
    for (let offset = 0; offset < value.length;) {
      if (used === bytes.length) flush();
      const count = Math.min(bytes.length - used, value.length - offset);
      bytes.set(value.subarray(offset, offset + count), used);
      used += count;
      offset += count;
    }
  }

  return {
    writeRow(row) {
      for (const value of row) {
        const tag = reserve(1);
        if (value === null) {
          bytes[tag] = 0;
        } else if (typeof value === "number") {
          bytes[tag] = 2;
          const offset = reserve(8);
          view.setFloat64(offset, value, true);
        } else if (typeof value === "string") {
          bytes[tag] = 3;
          writeText(value);
        } else if (value instanceof Uint8Array) {
          bytes[tag] = 4;
          writeBlob(value);
        } else {
          bytes[tag] = 1;
          const offset = reserve(8);
          view.setBigInt64(offset, BigInt(value.integer), true);
        }
      }
    },
    finish: flush,
  };
}

// Application reads always use bounded frames. The ordinary JSON envelope
// carries metadata, write counts and errors.
export function sqliteHost(memory, receiveFrame, runQuery, logError) {
  let response;
  return {
    sql(pointer, size) {
      const query = JSON.parse(frameDecoder.decode(new Uint8Array(memory(), pointer, size)));
      let result;
      try {
        if (query.query && (!query.framePointer || !receiveFrame)) {
          throw new Error("MaPi SQLite requires a framed result receiver");
        }
        const sink = query.query ? resultSink(memory, receiveFrame, query.framePointer) : null;
        result = runQuery(query, sink);
      } catch (error) {
        logError?.(query, error);
        result = { error: sqliteError(error) };
      }
      response = frameEncoder.encode(JSON.stringify(result));
      return response.length;
    },
    result(pointer, size) {
      new Uint8Array(memory(), pointer, size).set(response);
      response.fill(0);
      response = undefined;
    },
  };
}
