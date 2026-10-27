// The text of an error, shared by the app and the pack worker: what a caught value says, and
// what a failed response from the server says.

/** What a caught value says: an Error's message, else the value as a string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What a failed response says: the server's `{"error": "..."}`, else its status line
 * (`HTTP 502 Bad Gateway`, or `HTTP 502` without a reason phrase, as over HTTP/2).
 */
export async function responseError(res: Response): Promise<string> {
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  try {
    const body: unknown = JSON.parse(await res.text());
    if (
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string' &&
      body.error
    )
      return body.error;
  } catch {
    // Not JSON (a proxy's HTML error page, say): the status line is the best there is.
  }
  return status;
}
