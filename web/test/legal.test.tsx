// @vitest-environment jsdom
// The legal page (site/LegalView): one address for legal requests, one line on data, one on Valve.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LegalView from '../src/site/LegalView';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LegalView', () => {
  it('gives the legal address and says what is stored', () => {
    render(<LegalView />);
    expect(screen.getByRole('heading', { name: 'Contact' })).toBeTruthy();
    const mail = screen.getByRole('link', { name: 'contact@skunk.legal' });
    expect(mail.getAttribute('href')).toBe('mailto:contact@skunk.legal');
    const cells = screen.getAllByTestId('legal-cell').map((c) => c.textContent);
    expect(cells).toEqual([
      "Legal requests Takedowns, privacy and data requests, and anything else that needs a lawyer's attention: contact@skunk.legal Say which page or match you mean and we'll reply from this address.",
      "Your data Matches here come from demos uploaded or linked on this site and from public pro tournament demos. A tracked player's authentication code and match token are kept only to fetch that player's matches from Steam, and are deleted when tracking is stopped. Stored demos are the files Valve serves to every player in the match. A profile can be hidden on request: write to the address above. Profiles, matches and tournament pages are public and may appear in search engines. Cloudflare counts visits without cookies. The only cookie is the sign-in session.",
      'skunk.club is not affiliated with Valve Corporation or FACEIT. Counter-Strike and Steam are trademarks of Valve Corporation; FACEIT and its mark are trademarks of FACEIT.',
    ]);
    expect(screen.getByText('Not affiliated with Valve')).toBeTruthy();
  });
});
