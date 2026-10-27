// Valve KeyValues3 text reader, enough for what VRF writes when it decompiles a
// resource (soundevents, surface properties): the `<!-- kv3 ... -->` header, then one
// value, usually a `{ }` object.
//
// An object is `key = value` entries separated by whitespace (a comma is tolerated).
// A key is a bare word or a "quoted string"; a dotted key such as `Weapon_X.Single`
// is one flat key, never a path. An array is `[ a, b, ]`, trailing comma allowed, and
// may be empty. A value is a "string" (or a """multi-line""" one), a number (sign,
// decimals, exponent), `true`, `false`, `null`, or an object or array. A type tag in
// front of a string (`resource:"x"`) is dropped and the string kept. A later duplicate
// key replaces an earlier one. `//` and `/* */` comments are skipped. Anything else throws a SyntaxError naming its line.

const SPACE = new Set([' ', '\t', '\r', '\n', '\v', '\f']);
const WORD = /[A-Za-z0-9_.\-+]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };

/**
 * @param {string} text
 * @returns {any} the document's one value
 */
export function parseKv3(text) {
  if (typeof text !== 'string') throw new TypeError('parseKv3: text must be a string');
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  const fail = (what) => {
    throw new SyntaxError(`KV3: ${what} at line ${line}`);
  };

  const skipSpace = () => {
    for (;;) {
      const c = text[i];
      if (c === '\n') line++;
      if (SPACE.has(c)) i++;
      else if (c === '<' && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i);
        if (end < 0) fail('unterminated header comment');
        for (let k = i; k < end; k++) if (text[k] === '\n') line++;
        i = end + 3;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment');
        for (let k = i; k < end; k++) if (text[k] === '\n') line++;
        i = end + 2;
      } else return;
    }
  };

  const word = () => {
    const start = i;
    while (i < text.length && WORD.test(text[i])) i++;
    return text.slice(start, i);
  };

  const string = () => {
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end < 0) fail('unterminated string');
      const s = text.slice(i + 3, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      for (let k = i; k < end; k++) if (text[k] === '\n') line++;
      i = end + 3;
      return s;
    }
    i++;
    let s = '';
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n') fail('unterminated string');
      i++;
      if (c === '"') return s;
      if (c !== '\\') {
        s += c;
        continue;
      }
      const e = text[i++];
      if (!(e in ESCAPES)) fail(`bad escape \\${e}`);
      s += ESCAPES[e];
    }
  };

  const value = () => {
    skipSpace();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === undefined) fail('unexpected end of input');
    const w = word();
    if (w === '') fail(`unexpected '${c}'`);
    if (text[i] === ':' && text[i + 1] === '"') {
      i++;
      return string();
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (NUMBER.test(w)) return Number(w);
    return fail(`unexpected '${w}'`);
  };

  const object = () => {
    i++;
    const obj = {};
    for (;;) {
      skipSpace();
      const c = text[i];
      if (c === '}') {
        i++;
        return obj;
      }
      if (c === ',') {
        i++;
        continue;
      }
      if (c === undefined) fail('unterminated object');
      const key = c === '"' ? string() : word();
      if (key === '') fail(`unexpected '${c}'`);
      skipSpace();
      if (text[i] !== '=') fail(`expected '=' after key '${key}'`);
      i++;
      Object.defineProperty(obj, key, {
        value: value(), enumerable: true, writable: true, configurable: true,
      });
    }
  };

  const array = () => {
    i++;
    const list = [];
    for (;;) {
      skipSpace();
      const c = text[i];
      if (c === ']') {
        i++;
        return list;
      }
      if (c === undefined) fail('unterminated array');
      list.push(value());
      skipSpace();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') fail(`expected ',' or ']' but found '${text[i] ?? 'end of input'}'`);
    }
  };

  const root = value();
  skipSpace();
  if (i < text.length) fail(`unexpected '${text[i]}' after the value`);
  return root;
}
