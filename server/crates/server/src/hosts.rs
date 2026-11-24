//! skunk.club is the one site: a request to an old host (`cs.skunk.to`,
//! `DEMOVIEWER_REDIRECT_HOSTS`) goes to the same path and query at the public URL, for good:
//! `301` for a read, `308` for anything else (it keeps its method and body). Any other host
//! (the health check's `127.0.0.1`, the public host itself) is served.

use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use url::Url;

/// `router` with the old `hosts` sent to `public_url`. Without a public URL there is nowhere to
/// send them: nothing is redirected (warned).
pub fn with_redirects<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    public_url: Option<Url>,
    hosts: Vec<String>,
) -> Router<S> {
    let hosts: Vec<String> = hosts
        .iter()
        .map(|h| bare_host(h))
        .filter(|h| !h.is_empty())
        .collect();
    if hosts.is_empty() {
        return router;
    }
    let Some(public_url) = public_url else {
        tracing::warn!(
            ?hosts,
            "DEMOVIEWER_REDIRECT_HOSTS is set without DEMOVIEWER_PUBLIC_URL: nothing is redirected"
        );
        return router;
    };
    let to = Arc::new((public_url.as_str().trim_end_matches('/').to_owned(), hosts));
    router.layer(middleware::from_fn(move |req: Request, next: Next| {
        let to = to.clone();
        async move {
            let host = req.uri().host().map(str::to_owned).or_else(|| {
                req.headers()
                    .get(header::HOST)
                    .and_then(|h| h.to_str().ok())
                    .map(str::to_owned)
            });
            if host.is_some_and(|h| to.1.contains(&bare_host(&h))) {
                return redirect(&to.0, &req);
            }
            next.run(req).await
        }
    }))
}

/// A host as compared: lowercase, without a port or a trailing dot.
fn bare_host(host: &str) -> String {
    let host = host.trim();
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !name.contains(']') || name.ends_with(']') => {
            if port.bytes().all(|b| b.is_ascii_digit()) {
                name
            } else {
                host
            }
        }
        _ => host,
    };
    name.trim_end_matches('.').to_ascii_lowercase()
}

fn redirect(base: &str, req: &Request) -> Response {
    let path = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let status = if matches!(*req.method(), Method::GET | Method::HEAD) {
        StatusCode::MOVED_PERMANENTLY
    } else {
        StatusCode::PERMANENT_REDIRECT
    };
    match HeaderValue::from_str(&format!("{base}{path}")) {
        Ok(location) => (
            status,
            [
                (header::LOCATION, location),
                (
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=86400"),
                ),
            ],
        )
            .into_response(),
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use tower::ServiceExt;
    use url::Url;

    use super::*;

    fn app() -> Router {
        let routes = Router::new()
            .route("/healthz", get(|| async { "ok" }))
            .route("/api/demos", post(|| async { "posted" }));
        with_redirects(
            routes,
            Some(Url::parse("https://skunk.club/").unwrap()),
            vec!["cs.skunk.to".into()],
        )
    }

    async fn call(method: &str, host: &str, uri: &str) -> axum::response::Response {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap();
        app().oneshot(req).await.unwrap()
    }

    #[tokio::test]
    async fn the_old_host_redirects_permanently_to_the_same_path() {
        for host in ["cs.skunk.to", "CS.Skunk.To:443", "cs.skunk.to."] {
            let res = call("GET", host, "/d/abc?r=3&t=10").await;
            assert_eq!(res.status(), StatusCode::MOVED_PERMANENTLY, "{host}");
            assert_eq!(
                res.headers()[header::LOCATION],
                "https://skunk.club/d/abc?r=3&t=10"
            );
            assert_eq!(
                res.headers()[header::CACHE_CONTROL],
                "public, max-age=86400"
            );
        }
        let res = call("HEAD", "cs.skunk.to", "/").await;
        assert_eq!(res.status(), StatusCode::MOVED_PERMANENTLY);
        assert_eq!(res.headers()[header::LOCATION], "https://skunk.club/");
    }

    #[tokio::test]
    async fn a_post_to_the_old_host_keeps_its_method() {
        let res = call("POST", "cs.skunk.to", "/api/demos").await;
        assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            res.headers()[header::LOCATION],
            "https://skunk.club/api/demos"
        );
    }

    #[tokio::test]
    async fn other_hosts_are_served() {
        for host in ["127.0.0.1:8095", "skunk.club", "evil.cs.skunk.to"] {
            let res = call("GET", host, "/healthz").await;
            assert_eq!(res.status(), StatusCode::OK, "{host}");
        }
    }

    #[tokio::test]
    async fn without_a_public_url_nothing_redirects() {
        let routes = Router::new().route("/healthz", get(|| async { "ok" }));
        let app = with_redirects(routes, None, vec!["cs.skunk.to".into()]);
        let req = Request::get("/healthz")
            .header(header::HOST, "cs.skunk.to")
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::OK);
    }
}
