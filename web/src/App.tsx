import { useEffect, useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import { parseRoute, type Route } from './router';
import { chunkOnce, useChunk } from './use-chunk';
import HomeView from './site/HomeView';
import LoadingBar from './site/LoadingBar';
import { removePre } from './site/pre';
import SitePending from './site/SitePending';

// The viewer, with everything it draws with (three.js and the scene among it), is a chunk of its
// own that loads when a demo opens: the home page does not download it. Opened from the home
// page (an upload, a link or a share code), the home page stays up until the chunk is in. A
// demo's own link shows the empty page until then, as it does while the app's own script loads,
// and the viewer as soon as it is in (`use-chunk`). A deploy since the page loaded reloads it
// (`importOrReload`).
const loadDemoView = chunkOnce(() => import('./views/DemoView'));
// The site's other pages load as chunks of their own too; the home page is in the entry, the
// first page most visitors (and every phone) see.
const loadProfileView = chunkOnce(() => import('./site/profile/ProfileView'));
const loadLegalView = chunkOnce(() => import('./site/LegalView'));
const loadEventsView = chunkOnce(() => import('./site/EventsView'));
const loadGuideView = chunkOnce(() => import('./site/GuideView'));
const loadTrackView = chunkOnce(() => import('./site/TrackView'));

function currentRoute() {
  return parseRoute(new URL(window.location.href));
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onPop = () => {
      // The server's pre-rendered body is the first address's, not this one's.
      removePre();
      setRoute(currentRoute());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A view that fails in render (or a viewer chunk that will not load) ends on the error
  // screen, and a new route, Back to the home page, tries again: the root boundary around App
  // (main.tsx), the last line, would keep its screen whatever the URL.
  return (
    <ErrorBoundary resetKey={route}>
      <View route={route} />
    </ErrorBoundary>
  );
}

/**
 * The route's view. Until the viewer's chunk is in, the home page stays (the same one, its
 * upload's progress and all) if it was up, and the page is empty if it was not.
 */
function View({ route }: { route: Route }) {
  const demo = route.view === 'demo';
  const DemoView = useChunk(loadDemoView, demo)?.default;
  const ProfileView = useChunk(
    loadProfileView,
    route.view === 'profile'
  )?.default;
  const LegalView = useChunk(loadLegalView, route.view === 'legal')?.default;
  const EventsView = useChunk(
    loadEventsView,
    route.view === 'events' || route.view === 'event'
  )?.default;
  const GuideView = useChunk(
    loadGuideView,
    route.view === 'guide' || route.view === 'guides'
  )?.default;
  const TrackView = useChunk(loadTrackView, route.view === 'track')?.default;
  const [homeShown, setHomeShown] = useState(route.view === 'home');
  if (route.view === 'home' && !homeShown) setHomeShown(true);
  switch (route.view) {
    case 'demo':
      if (DemoView)
        return <DemoView key={route.demoId} demoId={route.demoId} />;
      return homeShown ? <HomeView /> : <LoadingBar />;
    // A site page's code still coming shows the site's frame and a loading bar, not nothing.
    case 'profile':
      return ProfileView ? (
        <ProfileView profile={route.ref} />
      ) : (
        <SitePending />
      );
    case 'legal':
      return LegalView ? <LegalView /> : <SitePending />;
    case 'track':
      return TrackView ? <TrackView /> : <SitePending />;
    case 'events':
      return EventsView ? <EventsView /> : <SitePending />;
    case 'event':
      return EventsView ? <EventsView slug={route.slug} /> : <SitePending />;
    case 'guides':
      return GuideView ? <GuideView /> : <SitePending />;
    case 'guide':
      return GuideView ? <GuideView slug={route.slug} /> : <SitePending />;
    case 'home':
      return <HomeView />;
  }
}
