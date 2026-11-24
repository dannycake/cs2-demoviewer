// What the viewer says when a match cannot be opened: the server's lower-case messages in the
// site's words.
import { describe, expect, it } from 'vitest';
import { errorCopy } from '../src/views/error-copy';

describe('errorCopy', () => {
  it('says an unknown id is not here', () => {
    expect(errorCopy('unknown demo')).toEqual({
      title: "This match isn't here",
      text: 'The link may be mistyped, or the match was never uploaded.',
    });
  });

  it('writes out an expired replay', () => {
    expect(
      errorCopy('this replay expired from the cache; upload the demo again')
        .title
    ).toBe('This replay has expired');
  });

  it('puts any other message in sentence case under a plain title', () => {
    expect(errorCopy('not a CS2 demo')).toEqual({
      title: "This match couldn't be opened",
      text: 'Not a CS2 demo.',
    });
    expect(errorCopy('HTTP 502 Bad Gateway.').text).toBe(
      'HTTP 502 Bad Gateway.'
    );
    expect(errorCopy('').text).toBe('Something went wrong while it loaded.');
  });
});
