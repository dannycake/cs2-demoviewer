//! Structured data for search engines: the schema.org JSON-LD the home, profile, match and
//! tournament pages carry. Each builder returns a [`Value`] and needs the site's public URL
//! (`base`), as every address in it must be absolute; [`json_ld_tag`] writes one as a script
//! element.

use serde_json::{json, Value};
use url::Url;

use crate::events::valid_slug;
use crate::events::EventSummary;
use crate::matches::MatchSummary;
use crate::pages::{civil_from_days, event_name, page_title, venue, HOME_DESCRIPTION};
use crate::profile::ProfileView;

/// The site's name, as the `WebSite` gives it.
const SITE_NAME: &str = "skunk.club";
/// What every match and tournament here is a match or tournament of.
const SPORT: &str = "Counter-Strike 2";

/// `v` as `<script type="application/ld+json">…</script>`. The JSON is serde's, so every string
/// in it is escaped; on top of that each `<` is written `\u003c` (the same string to a JSON
/// reader), so no name can close the element (`</script>`), open a comment (`<!--`) or put a
/// tag of its own in the page.
pub fn json_ld_tag(v: &Value) -> String {
    let json = v.to_string().replace('<', "\\u003c");
    format!(r#"<script type="application/ld+json">{json}</script>"#)
}

/// `path` under `base`, as text; `base` itself when `path` cannot be joined (never for the
/// valid ids and slugs the callers pass).
fn under(base: &Url, path: &str) -> String {
    base.join(path)
        .map_or_else(|_| base.to_string(), String::from)
}

/// The `WebSite` of the home page, with the search the home page's input answers (`/?q=`).
pub fn website(base: &Url) -> Value {
    json!({
        "@context": "https://schema.org",
        "@type": "WebSite",
        "url": base.as_str(),
        "name": SITE_NAME,
        "potentialAction": {
            "@type": "SearchAction",
            "target": {
                "@type": "EntryPoint",
                "urlTemplate": format!("{}?q={{search_term_string}}", base.as_str()),
            },
            "query-input": "required name=search_term_string",
        },
    })
}

/// The `Organization` behind the site: its name, address and logo.
pub fn organization(base: &Url) -> Value {
    json!({
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": SITE_NAME,
        "url": base.as_str(),
        "logo": under(base, "icon-512.png"),
    })
}

/// What the site is, for a search engine that files it: the free viewer in the browser.
pub fn web_app(base: &Url) -> Value {
    json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": SITE_NAME,
        "url": base.as_str(),
        "description": HOME_DESCRIPTION,
        "applicationCategory": "GameApplication",
        "browserRequirements": "Requires WebGL",
        "operatingSystem": "Any",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    })
}

/// The `ProfilePage` of a player named `name`, whose main entity is the `Person`.
pub fn profile(base: &Url, view: &ProfileView, name: &str) -> Value {
    let url = under(base, &format!("profiles/{}", view.steamid));
    let mut person = json!({
        "@type": "Person",
        "name": name,
        "identifier": view.steamid,
        "url": url,
    });
    if let Some(avatar) = &view.avatar {
        person["image"] = json!(avatar);
    }
    // The same player elsewhere: Steam always, FACEIT when the account is linked (the address
    // the web app's `faceitProfileUrl` writes).
    let mut same_as = vec![format!(
        "https://steamcommunity.com/profiles/{}",
        view.steamid
    )];
    if let Some(faceit) = &view.faceit {
        same_as.push(format!(
            "https://www.faceit.com/en/players/{}",
            percent_encode(&faceit.nickname)
        ));
    }
    person["sameAs"] = json!(same_as);
    json!({
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "url": url,
        "mainEntity": person,
    })
}

/// The `SportsEvent` of match `id`: its title, where it was played and when if that is known, its
/// page and its preview image.
pub fn match_event(base: &Url, id: &str, m: &MatchSummary) -> Value {
    let mut v = json!({
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        "name": page_title(m),
        "sport": SPORT,
        "location": { "@type": "Place", "name": venue(m) },
        "url": under(base, &format!("d/{id}")),
        "image": under(base, &format!("og/{id}.jpg")),
    });
    if let Some(at) = m.played() {
        v["startDate"] = json!(iso_8601(at));
    }
    if let Some([a, b]) = &m.teams {
        v["competitor"] = json!([
            { "@type": "SportsTeam", "name": a },
            { "@type": "SportsTeam", "name": b },
        ]);
    }
    if let Some((slug, name)) = known_event(m) {
        v["superEvent"] = json!({
            "@type": "SportsEvent",
            "name": name,
            "url": under(base, &format!("events/{slug}")),
        });
    }
    v
}

/// The tournament a match belongs to, as its slug and name, when its slug is a valid one.
fn known_event(m: &MatchSummary) -> Option<(&str, String)> {
    let slug = m.event.as_deref().filter(|s| valid_slug(s))?;
    Some((slug, event_name(slug)))
}

/// The `BreadcrumbList` of match `id`: Home, then (when its tournament is known) Tournaments and the tournament, then itself.
pub fn match_breadcrumbs(base: &Url, id: &str, m: &MatchSummary) -> Value {
    let (title, own) = (page_title(m), format!("d/{id}"));
    let event = known_event(m).map(|(slug, name)| (name, format!("events/{slug}")));
    let mut trail = vec![("Home", "")];
    if let Some((name, path)) = &event {
        trail.extend([("Tournaments", "events"), (name, path)]);
    }
    trail.push((&title, &own));
    breadcrumbs(base, &trail)
}

/// A `BreadcrumbList` of `trail`: each step's name and its path under `base` (empty for the
/// home page), numbered from 1, with absolute addresses.
pub fn breadcrumbs(base: &Url, trail: &[(&str, &str)]) -> Value {
    let items: Vec<Value> = trail
        .iter()
        .enumerate()
        .map(|(i, (name, path))| {
            json!({
                "@type": "ListItem",
                "position": i + 1,
                "name": name,
                "item": under(base, path),
            })
        })
        .collect();
    json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items,
    })
}

/// `s` as a URL path segment, as JavaScript's `encodeURIComponent` writes it: everything but
/// `A-Za-z0-9-_.!~*'()` as percent-escaped UTF-8.
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The `SportsEvent` of a tournament, with its first and last day when they are known.
pub fn event(base: &Url, e: &EventSummary) -> Value {
    let mut v = json!({
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        "name": e.name,
        "sport": SPORT,
        "url": under(base, &format!("events/{}", e.slug)),
    });
    if let (Some(first), Some(last)) = (e.first_unix, e.last_unix) {
        v["startDate"] = json!(iso_8601(first));
        v["endDate"] = json!(iso_8601(last));
    }
    v
}

/// The Unix time `unix` as ISO 8601 in UTC: `2025-10-22T20:00:00Z`.
pub(crate) fn iso_8601(unix: u64) -> String {
    let (y, mo, d) = civil_from_days(unix / 86_400);
    let secs = unix % 86_400;
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_safe_inside_a_script_element() {
        let tag = json_ld_tag(&json!({ "name": "a</script><!-- b" }));
        let inner = tag
            .strip_prefix(r#"<script type="application/ld+json">"#)
            .and_then(|t| t.strip_suffix("</script>"))
            .expect("one element");
        assert!(!inner.contains("</") && !inner.contains("<!--"), "{inner}");
        let back: Value = serde_json::from_str(inner).unwrap();
        assert_eq!(back["name"], "a</script><!-- b");
    }

    #[test]
    fn start_date_is_iso_8601_utc() {
        assert_eq!(iso_8601(1_761_163_200), "2025-10-22T20:00:00Z");
        assert_eq!(iso_8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_8601(1_761_300_000 + 61), "2025-10-24T10:01:01Z");
    }
}
