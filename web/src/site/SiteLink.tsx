// A link to another page of the site: a plain link, followed without a page load (`navigate`)
// when clicked without a modifier.

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { navigate } from '../router';

export default function SiteLink({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={follow} {...rest} />;
}
