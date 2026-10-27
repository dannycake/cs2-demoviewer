import { describe, expect, it } from 'vitest';
import { messageOf, responseError } from '../src/errors';

describe('messageOf', () => {
  it("says an Error's message, else the value as a string", () => {
    expect(messageOf(new TypeError('bad'))).toBe('bad');
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(404)).toBe('404');
    expect(messageOf(null)).toBe('null');
  });
});

describe('responseError', () => {
  const res = (body: string, init: ResponseInit) => new Response(body, init);

  it("says the server's {error}", async () => {
    expect(
      await responseError(
        res('{"error":"unknown demo"}', {
          status: 404,
          statusText: 'Not Found',
        })
      )
    ).toBe('unknown demo');
  });

  it('falls back to the status line when the body has no error text', async () => {
    for (const body of [
      '<html>Bad Gateway</html>',
      '{}',
      '{"error":""}',
      'null',
    ])
      expect(
        await responseError(
          res(body, { status: 502, statusText: 'Bad Gateway' })
        )
      ).toBe('HTTP 502 Bad Gateway');
    // HTTP/2 has no reason phrase.
    expect(await responseError(res('', { status: 500 }))).toBe('HTTP 500');
  });
});
