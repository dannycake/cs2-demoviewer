// Valve KeyValues1 reader, enough for resource/overviews/<map>.txt and files like it.
//
// A token is a "quoted string" (no escape sequences) or a bare run of characters
// that stops at whitespace, a brace or a quote, as in Valve's own reader. `//`
// starts a comment only where a token could start, so `http://x` stays one bare
// token. A value is either a token or a `{ ... }` block of further key/value pairs.
// Case is preserved, numbers stay strings, and a duplicate key replaces the
// earlier one (last wins). #include/#base and [$CONDITIONAL] tags are not supported.

const SPACE = new Set([' ', '\t', '\r', '\n', '\v', '\f']);
const STOP = new Set([...SPACE, '{', '}', '"']);

/**
 * @param {string} text
 * @returns {Record<string, any>} nested objects of strings
 */
export function parseKv(text) {
  if (typeof text !== 'string') throw new TypeError('parseKv: text must be a string');
  const tokens = tokenize(text);
  const root = {};
  // Open blocks, innermost last; `line` is where each block's '{' was.
  const stack = [{ obj: root, line: 0 }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === '}') {
      if (stack.length === 1) throw new SyntaxError(`KeyValues: unexpected '}' at line ${t.line}`);
      stack.pop();
      continue;
    }
    if (t.type === '{') {
      throw new SyntaxError(`KeyValues: unexpected '{' at line ${t.line} (expected a key)`);
    }
    const v = tokens[++i];
    if (!v || v.type === '}') {
      throw new SyntaxError(`KeyValues: no value for key ${JSON.stringify(t.value)} at line ${t.line}`);
    }
    const obj = stack[stack.length - 1].obj;
    if (v.type === '{') {
      const child = {};
      put(obj, t.value, child);
      stack.push({ obj: child, line: v.line });
    } else {
      put(obj, t.value, v.value);
    }
  }
  if (stack.length > 1) {
    throw new SyntaxError(`KeyValues: unclosed '{' opened at line ${stack[stack.length - 1].line}`);
  }
  return root;
}

/** Own, enumerable data property even for keys like "__proto__"; last write wins. */
function put(obj, key, value) {
  delete obj[key];
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** @returns {{type: 'str'|'{'|'}', value?: string, line: number}[]} */
function tokenize(text) {
  const out = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // byte-order mark
  let line = 1;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
    } else if (SPACE.has(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '{' || c === '}') {
      out.push({ type: c, line });
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new SyntaxError(`KeyValues: unterminated quoted string starting at line ${line}`);
      const value = text.slice(i + 1, end);
      out.push({ type: 'str', value, line });
      for (const ch of value) if (ch === '\n') line++;
      i = end + 1;
    } else {
      let j = i;
      while (j < n && !STOP.has(text[j])) j++;
      out.push({ type: 'str', value: text.slice(i, j), line });
      i = j;
    }
  }
  return out;
}
