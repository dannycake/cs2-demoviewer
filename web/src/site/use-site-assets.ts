// The site manifest (api/site-assets) in a component: null until it is in, and when there is none.

import { useEffect, useState } from 'react';
import { siteAssets, type SiteAssets } from '../api/site-assets';

export function useSiteAssets(): SiteAssets | null {
  const [assets, setAssets] = useState<SiteAssets | null>(null);
  useEffect(() => {
    let live = true;
    void siteAssets().then((a) => {
      if (live) setAssets(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return assets;
}
