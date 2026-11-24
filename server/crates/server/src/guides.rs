//! The how-to pages (`/guides/{slug}`): each guide's body is one HTML fragment in `guides/`,
//! embedded here for crawlers and imported as raw text by the web app (`GuideView`), so the two
//! cannot drift. The page's `<h1>` is added from the title, not part of the fragment.

use axum::extract::rejection::PathRejection;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::api::AppState;
use crate::pages::{
    app_page, html, into_head, into_pre, site_scripts, site_tags, NOINDEX, SITE_NAME,
};
use crate::prerender;
use crate::structured;

pub struct Guide {
    pub slug: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub body: &'static str,
    /// The day it was written, `YYYY-MM-DD`.
    pub published: &'static str,
}

/// The guides index's title, and its description.
const INDEX_TITLE: &str = "CS2 demo guides";
const INDEX_DESCRIPTION: &str =
    "Short guides to CS2 demos: how to download them, watch them in your browser in 3D, track your match history and open FACEIT demos.";

pub const GUIDES: [Guide; 4] = [
    Guide {
        slug: "watch-cs2-demos-in-your-browser",
        title: "How to watch a CS2 demo in your browser",
        description: "Open any CS2 demo as a 3D replay without installing anything: from a .dem file, a share code or a FACEIT match room.",
        body: include_str!("../guides/watch-cs2-demos-in-your-browser.html"),
        published: "2026-10-31",
    },
    Guide {
        slug: "download-cs2-demos",
        title: "How to download a CS2 demo and find its share link",
        description: "Where CS2 keeps your match demos, how to download one or copy its share link, and how to open either as a 3D replay in your browser.",
        body: include_str!("../guides/download-cs2-demos.html"),
        published: "2026-11-01",
    },
    Guide {
        slug: "track-your-cs2-matches",
        title: "How to get your CS2 match history tracked automatically",
        description: "Link your Steam account once and every CS2 match you finish is fetched, parsed and kept with a 3D replay on your profile.",
        body: include_str!("../guides/track-your-cs2-matches.html"),
        published: "2026-10-31",
    },
    Guide {
        slug: "watch-faceit-demos",
        title: "How to watch a FACEIT demo in 3D",
        description: "Paste a FACEIT match room link; when FACEIT does not serve the demo, download it from the room and upload it here.",
        body: include_str!("../guides/watch-faceit-demos.html"),
        published: "2026-10-31",
    },
];

/// The guide with `slug`.
pub fn find(slug: &str) -> Option<&'static Guide> {
    GUIDES.iter().find(|g| g.slug == slug)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guides", get(guides_page))
        .route("/guides/", get(crate::pages::redirect_slashless))
        .route("/guides/{slug}", get(guide_page))
        .route("/guides/{slug}/", get(crate::pages::redirect_slashless))
}

/// `/guides`: every guide, each linking to its page.
async fn guides_page(State(s): State<AppState>) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let title = format!("{INDEX_TITLE} · {SITE_NAME}");
    let mut tags = site_tags(&s, "guides", INDEX_TITLE, INDEX_DESCRIPTION, false);
    if let Some(base) = s.cfg.public_url.as_ref() {
        tags.push(structured::json_ld_tag(&structured::breadcrumbs(
            base,
            &[("Home", ""), ("Guides", "guides")],
        )));
    }
    html(
        StatusCode::OK,
        into_pre(
            into_head(&template, Some(&title), Some(INDEX_DESCRIPTION), &tags),
            &prerender::guides_html(INDEX_TITLE),
        ),
    )
}

/// `/guides/{slug}`: the guide's body for crawlers, with its `Article` and breadcrumbs. An
/// unknown slug is a 404 and `noindex`, never naming the slug.
async fn guide_page(
    State(s): State<AppState>,
    slug: Result<UrlPath<String>, PathRejection>,
) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let slug = slug.map(|UrlPath(slug)| slug).unwrap_or_default();
    let Some(g) = find(&slug) else {
        let title = format!("Guide not found · {SITE_NAME}");
        let mut tags = vec![NOINDEX.to_owned()];
        tags.extend(site_scripts(&s.cfg));
        return html(
            StatusCode::NOT_FOUND,
            into_head(&template, Some(&title), None, &tags),
        );
    };
    let path = format!("guides/{slug}");
    let title = format!("{} · {SITE_NAME}", g.title);
    let mut tags = site_tags(&s, &path, g.title, g.description, false);
    for t in &mut tags {
        if t.contains(r#"property="og:type""#) {
            *t = t.replace(r#"content="website""#, r#"content="article""#);
        }
    }
    if let Some(base) = s.cfg.public_url.as_ref() {
        let org = structured::organization(base);
        tags.push(structured::json_ld_tag(&json!({
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": g.title,
            "description": g.description,
            "datePublished": g.published,
            "dateModified": g.published,
            "url": base.join(&path).map_or_else(|_| base.to_string(), String::from),
            "author": {"@type": "Organization", "name": SITE_NAME, "url": base.as_str()},
            "publisher": org,
        })));
        tags.push(structured::json_ld_tag(&structured::breadcrumbs(
            base,
            &[("Home", ""), ("Guides", "guides"), (g.title, &path)],
        )));
    }
    let body = prerender::guide_html(g.title, g.body);
    html(
        StatusCode::OK,
        into_pre(
            into_head(&template, Some(&title), Some(g.description), &tags),
            &body,
        ),
    )
}
