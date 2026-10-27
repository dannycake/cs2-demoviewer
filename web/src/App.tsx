import { useEffect, useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import { parseRoute, type Route } from './router';
import { chunkOnce, useChunk } from './use-chunk';
import UploadView from './views/UploadView';

// The viewer, with everything it draws with (three.js and the scene among it), is a chunk of its
// own that loads when a demo opens: the upload page does not download it. Opened from the upload
// page (an upload, a link or a share code), the upload page stays up until the chunk is in. A
// demo's own link shows the empty page until then, as it does while the app's own script loads,
// and the viewer as soon as it is in (`use-chunk`). A deploy since the page loaded reloads it
// (`importOrReload`).
const loadDemoView = chunkOnce(() => import('./views/DemoView'));

function currentRoute() {
  return parseRoute(new URL(window.location.href));
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A view that fails in render (or a viewer chunk that will not load) ends on the error
  // screen, and a new route, Back to the upload page, tries again: the root boundary around App
  // (main.tsx), the last line, would keep its screen whatever the URL.
  return (
    <ErrorBoundary resetKey={route}>
      <View route={route} />
    </ErrorBoundary>
  );
}

/**
 * The route's view. Until the viewer's chunk is in, the upload page stays (the same one, its
 * upload's progress and all) if it was up, and the page is empty if it was not.
 */
function View({ route }: { route: Route }) {
  const demo = route.view === 'demo';
  const DemoView = useChunk(loadDemoView, demo)?.default;
  const [uploadShown, setUploadShown] = useState(!demo);
  if (!demo && !uploadShown) setUploadShown(true);
  if (route.view === 'demo' && DemoView)
    return <DemoView key={route.demoId} demoId={route.demoId} />;
  return demo && !uploadShown ? null : <UploadView />;
}
