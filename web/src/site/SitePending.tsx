// A site page whose code is still coming: the site's bar, a loading bar and the foot, so the
// screen is never only black. Over the server's pre-rendered page (`pre.ts`), the bar and the
// loading bar alone (`PreFrame`): the pre-rendered body is the page under them.

import LoadingBar from './LoadingBar';
import { hasPre } from './pre';
import PreFrame from './PreFrame';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';

export default function SitePending() {
  if (hasPre()) return <PreFrame />;
  return (
    <div className="site">
      <SiteBar />
      <LoadingBar />
      <main />
      <SiteFoot />
    </div>
  );
}
