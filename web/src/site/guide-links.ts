// The guides' addresses and titles, as the server titles them (guides.rs; held by
// test/guide-view.test.tsx). Apart from their bodies (./guides.ts), so a page that only links to
// them does not carry them.

export const GUIDE_LINKS: { slug: string; title: string }[] = [
  {
    slug: 'watch-cs2-demos-in-your-browser',
    title: 'How to watch a CS2 demo in your browser',
  },
  {
    slug: 'download-cs2-demos',
    title: 'How to download a CS2 demo and find its share link',
  },
  {
    slug: 'track-your-cs2-matches',
    title: 'How to get your CS2 match history tracked automatically',
  },
  { slug: 'watch-faceit-demos', title: 'How to watch a FACEIT demo in 3D' },
];
