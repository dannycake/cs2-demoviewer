// What the viewer says when a match cannot be opened, in the site's words: a title for what
// happened and a sentence under it. The server's own messages are lower case, without a stop
// ("unknown demo"; "this replay expired from the cache; upload the demo again"): the known ones
// are written out, and any other is put in sentence case under a plain title.

export interface ErrorCopy {
  title: string;
  text: string;
}

/** `s` as a sentence: a capital first letter and a stop at the end. */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}

/** The panel's words for the error `message` (the server's or the loader's). */
export function errorCopy(message: string): ErrorCopy {
  const m = message.trim();
  if (m === 'unknown demo')
    return {
      title: "This match isn't here",
      text: 'The link may be mistyped, or the match was never uploaded.',
    };
  if (/expired from the cache/.test(m))
    return {
      title: 'This replay has expired',
      text: 'It is no longer kept on the server. Upload the demo again to watch it.',
    };
  if (/server restarted before/.test(m))
    return { title: "This match wasn't finished", text: sentence(m) };
  return {
    title: "This match couldn't be opened",
    text: sentence(m) || 'Something went wrong while it loaded.',
  };
}
