import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  TEMPLATE,
  checkVault,
  followQr,
  opReference,
  parseArgs,
  runOp,
  storeToken,
} from '../src/login.mjs';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJzdGVhbSJ9.c2VjcmV0';
/** Where the tests' 1Password keeps the token: made-up names, as a template would give them. */
const REF = { vault: 'Vault', item: 'gcbot-steam', field: 'REFRESH_TOKEN' };

/** A fake `op`: answers `item get` as told and records every call's argv and stdin. */
function fakeOp(getAnswer) {
  const calls = [];
  const op = async (args, input = '') => {
    calls.push({ args, input });
    if (args[0] === 'item' && args[1] === 'get') return getAnswer;
    return { code: 0, stdout: '{}', stderr: '' };
  };
  return { op, calls };
}

describe('storeToken', () => {
  it('creates the item from a template on stdin when it does not exist', async () => {
    const { op, calls } = fakeOp({
      code: 1,
      stdout: '',
      stderr: '[ERROR] "gcbot-steam" isn\'t an item in the "Vault" vault.',
    });
    await storeToken(TOKEN, REF, { op });
    assert.deepEqual(calls[0].args, [
      'item',
      'get',
      'gcbot-steam',
      '--vault',
      'Vault',
      '--format',
      'json',
    ]);
    assert.deepEqual(calls[1].args, ['item', 'create', '--vault', 'Vault', '-']);
    const item = JSON.parse(calls[1].input);
    assert.equal(item.title, 'gcbot-steam');
    const field = item.fields.find((f) => f.label === 'REFRESH_TOKEN');
    assert.deepEqual([field.type, field.value], ['CONCEALED', TOKEN]);
    for (const c of calls) assert.ok(!c.args.join(' ').includes(TOKEN), 'token in argv');
  });

  it('edits the existing item through stdin, keeping its other fields', async () => {
    const existing = {
      id: 'abc',
      title: 'gcbot-steam',
      category: 'SECURE_NOTE',
      fields: [
        {
          id: 'notesPlain',
          label: 'notesPlain',
          type: 'STRING',
          purpose: 'NOTES',
          value: 'the alt',
        },
        { id: 'xyz', label: 'REFRESH_TOKEN', type: 'CONCEALED', value: 'old' },
      ],
    };
    const { op, calls } = fakeOp({ code: 0, stdout: JSON.stringify(existing), stderr: '' });
    await storeToken(TOKEN, REF, { op });
    assert.deepEqual(calls[1].args, ['item', 'edit', 'gcbot-steam', '--vault', 'Vault']);
    const item = JSON.parse(calls[1].input);
    assert.equal(item.fields.length, 2);
    assert.equal(item.fields[0].value, 'the alt');
    assert.deepEqual([item.fields[1].type, item.fields[1].value], ['CONCEALED', TOKEN]);
    for (const c of calls) assert.ok(!c.args.join(' ').includes(TOKEN), 'token in argv');
  });

  it('stops on any other op failure', async () => {
    const { op, calls } = fakeOp({ code: 1, stdout: '', stderr: '[ERROR] authorization timeout' });
    await assert.rejects(storeToken(TOKEN, REF, { op }), /authorization timeout/);
    assert.equal(calls.length, 1);
  });

  it('sets the field the reference names', async () => {
    const { op, calls } = fakeOp({
      code: 0,
      stdout: JSON.stringify({ title: 'x', fields: [] }),
      stderr: '',
    });
    await storeToken(TOKEN, { ...REF, field: 'token' }, { op });
    const item = JSON.parse(calls[1].input);
    assert.deepEqual(item.fields, [
      { id: 'token', label: 'token', type: 'CONCEALED', value: TOKEN },
    ]);
  });
});

describe('opReference', () => {
  it("reads the vault, item and field of the template's STEAM_REFRESH_TOKEN line", () => {
    const text =
      '# a comment naming op://Other/thing/x\r\nGCBOT_PORT=8097\r\n STEAM_REFRESH_TOKEN = op://My Vault/gcbot steam/REFRESH_TOKEN \r\n';
    assert.deepEqual(opReference(text), {
      vault: 'My Vault',
      item: 'gcbot steam',
      field: 'REFRESH_TOKEN',
    });
  });

  it('is null for a template without one, or with a token or a short reference in its place', () => {
    for (const text of [
      '',
      'GCBOT_PORT=8097\n',
      'STEAM_REFRESH_TOKEN=eyJ.x.y\n',
      'STEAM_REFRESH_TOKEN=op://Vault/item\n',
      '# STEAM_REFRESH_TOKEN=op://Vault/item/field\n',
    ]) {
      assert.equal(opReference(text), null, text);
    }
  });

  it(
    "reads this checkout's gcbot.env.tpl, when it has one",
    { skip: !existsSync(TEMPLATE) },
    () => {
      const ref = opReference(readFileSync(TEMPLATE, 'utf8'));
      assert.ok(ref && ref.vault && ref.item && ref.field, 'no STEAM_REFRESH_TOKEN=op://… line');
    }
  );
});

describe('parseArgs', () => {
  it('takes --png and --state, each with a value', () => {
    assert.deepEqual(parseArgs([]), { png: undefined, state: undefined });
    assert.deepEqual(parseArgs(['--state', '/srv/state', '--png', 'qr.png']), {
      png: 'qr.png',
      state: '/srv/state',
    });
  });

  it('throws the usage for anything else, or a flag without its value', () => {
    for (const args of [
      ['--state'],
      ['--png', '--state', 'x'],
      ['--stat', 'x'],
      ['x'],
      ['constructor', 'x'],
    ]) {
      assert.throws(
        () => parseArgs(args),
        /^Error: usage: node src\/login\.mjs \[--png <file>\] \[--state <dir>\]$/,
        args.join(' ')
      );
    }
  });
});

describe('followQr', () => {
  it('shows each new challenge Steam sends, once, and ignores the rest of the debug chatter', () => {
    const session = new EventEmitter();
    const shown = [];
    followQr(session, 'https://s.team/q/1/111', (url) => shown.push(url));
    session.emit('debug', 'poll response', { newChallengeUrl: '' });
    session.emit('debug', 'poll response', { newChallengeUrl: 'https://s.team/q/1/111' });
    session.emit('debug', 'start qr session response', { newChallengeUrl: 'https://s.team/q/1/999' });
    session.emit('debug', 'poll response', { newChallengeUrl: 'https://s.team/q/1/222' });
    session.emit('debug', 'poll response', { newChallengeUrl: 'https://s.team/q/1/222' });
    session.emit('debug', 'poll response', {});
    session.emit('debug', 'poll response', { newChallengeUrl: 'https://s.team/q/1/333' });
    assert.deepEqual(shown, ['https://s.team/q/1/222', 'https://s.team/q/1/333']);
  });
});

describe('checkVault', () => {
  it('passes when op can read the vault', async () => {
    const { op, calls } = fakeOp();
    await checkVault('Vault', { op });
    assert.deepEqual(calls[0].args, ['vault', 'get', 'Vault', '--format', 'json']);
  });

  it('throws with op\'s reason when 1Password refuses, before anyone scans', async () => {
    const refused = async () => ({
      code: 1,
      stdout: '',
      stderr: '[ERROR] error initializing client: authorization prompt dismissed, please try again\n',
    });
    await assert.rejects(
      checkVault('Vault', { op: refused }),
      /cannot read the Vault vault: .*prompt dismissed/
    );
  });
});

describe('runOp', () => {
  it('hands the input to the command on a real pipe, which is all op reads stdin from', async () => {
    const got = await runOp(['-c', '[ -p /dev/stdin ] && cat', 'probe'], '{"title":"x"}', {
      bin: 'sh',
    });
    assert.deepEqual([got.code, got.stdout], [0, '{"title":"x"}']);
  });

  it('passes every argument through unchanged', async () => {
    const got = await runOp(['-c', 'printf "%s|" "$@"', 'sh', 'a b', '--vault', 'Vault'], '', {
      bin: 'sh',
    });
    assert.equal(got.stdout, 'a b|--vault|Vault|');
  });
});
