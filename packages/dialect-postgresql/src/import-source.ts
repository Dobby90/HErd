import type { Diagnostic, StatementResult } from '@erd/sql-contract';

export type Location = NonNullable<Diagnostic['location']>;
export interface SourceEntry {
  offset: number;
  length: number;
  kind: string;
  status: StatementResult['status'];
  message: string;
}

export function sourceLocations(source: string) {
  const lines = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === '\n' || (source[offset] === '\r' && source[offset + 1] !== '\n')) lines.push(offset + 1);
  }
  return (offset: number, length = 1): Location => {
    let low = 0;
    let high = lines.length;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= offset) low = middle;
      else high = middle;
    }
    return { offset, length, line: low + 1, column: [...source.slice(lines[low], offset)].length + 1 };
  };
}

export function characterOffset(source: string, position: number) {
  let offset = 0;
  let count = 0;
  for (const character of source) {
    if (count++ >= position) break;
    offset += character.length;
  }
  return offset;
}

export function preprocessSql(source: string) {
  const entries: SourceEntry[] = [];
  let result = '';
  let last = 0;
  let lineStart = 0;
  let block = 0;
  let quote = '';
  let escape = false;
  let guard: { token: string; offset: number; length: number } | undefined;
  let guardSeen = false;
  if (source.startsWith('\uFEFF')) { result = ' '; last = 1; lineStart = 1; }
  for (let offset = last; offset < source.length; offset += 1) {
    const char = source[offset];
    const next = source[offset + 1];
    if (char === '\n' || (char === '\r' && next !== '\n')) lineStart = offset + 1;
    if (quote) {
      if (quote.length > 1 || quote === '$$') {
        if (char === '$' && source.startsWith(quote, offset)) { offset += quote.length - 1; quote = ''; }
      } else if (char === quote) {
        if (next === quote) offset += 1;
        else quote = '';
      } else if (escape && char === '\\' && next !== undefined) {
        if (next === '\n' || (next === '\r' && source[offset + 2] !== '\n')) lineStart = offset + 2;
        offset += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') { block += 1; offset += 1; continue; }
    if (block && char === '*' && next === '/') { block -= 1; offset += 1; continue; }
    if (block) continue;
    if (char === '-' && next === '-') {
      while (offset + 1 < source.length && !/[\r\n]/.test(source[offset + 1])) offset += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      escape = char === "'" && /[eE]/.test(source[offset - 1] ?? '') && !/[\w$\u0080-\uFFFF]/.test(source[offset - 2] ?? '');
      continue;
    }
    if (char === '$' && !/[\w$\u0080-\uFFFF]/.test(source[offset - 1] ?? '')) {
      const delimiter = /\$(?:[a-zA-Z_\u0080-\uFFFF][a-zA-Z_0-9\u0080-\uFFFF]*)?\$/y;
      delimiter.lastIndex = offset;
      const match = delimiter.exec(source);
      if (match) { quote = match[0]; offset += quote.length - 1; continue; }
    }
    if (char !== '\\') continue;
    let end = offset + 1;
    while (end < source.length && !/[\r\n]/.test(source[end])) end += 1;
    const content = source.slice(offset, end);
    const command = /^\\(restrict|unrestrict)[ \t]+([a-zA-Z0-9]+)[ \t]*$/.exec(content);
    const standalone = !source.slice(lineStart, offset).trim();
    const length = end - offset;
    if (command?.[1] === 'restrict' && standalone && !guardSeen) {
      guardSeen = true;
      guard = { token: command[2], offset, length };
    } else if (command?.[1] === 'unrestrict' && standalone && guard?.token === command[2]) {
      guard = undefined;
    } else {
      entries.push({ offset, length, kind: 'psql', status: 'error', message: '허용되지 않거나 짝이 맞지 않는 psql 명령입니다.' });
      offset = end - 1;
      continue;
    }
    // Accepted dump directives are ASCII. Keeping their length preserves both byte and text offsets.
    entries.push({ offset, length, kind: 'psql', status: 'ignored-nonstructural', message: 'pg_dump의 psql 세션 제어문입니다.' });
    result += source.slice(last, offset) + ' '.repeat(length);
    last = end;
    offset = end - 1;
  }
  if (guard) entries.push({ offset: guard.offset, length: guard.length, kind: 'psql', status: 'error', message: 'pg_dump의 unrestrict 짝을 찾을 수 없습니다.' });
  return { sql: result + source.slice(last), entries };
}

export function statementRanges(sql: string) {
  const bytes = Buffer.from(sql);
  let byte = 0;
  let text = 0;
  function offset(position: number) {
    text += bytes.subarray(byte, position).toString('utf8').length;
    byte = position;
    return text;
  }
  return (startByte: number, lengthByte: number) => {
    const start = offset(startByte);
    const end = offset(lengthByte ? startByte + lengthByte : bytes.length);
    let startToken = start;
    while (startToken < end) {
      if (/\s/.test(sql[startToken])) { startToken += 1; continue; }
      if (sql.startsWith('--', startToken)) {
        while (startToken < end && !/[\r\n]/.test(sql[startToken])) startToken += 1;
        continue;
      }
      if (sql.startsWith('/*', startToken)) {
        let nested = 1;
        startToken += 2;
        while (nested && startToken < end) {
          if (sql.startsWith('/*', startToken)) { nested += 1; startToken += 2; }
          else if (sql.startsWith('*/', startToken)) { nested -= 1; startToken += 2; }
          else startToken += 1;
        }
        continue;
      }
      break;
    }
    return { offset: startToken, length: end - startToken };
  };
}
