//! What the modules share about answers from other services: a body read only up to a cap.

/// The body of `res`, or `None` when it passes `max` bytes: by its `Content-Length` before any
/// of it is read, else as soon as what has come passes it, so a huge or endless body is never
/// held whole.
pub(crate) async fn read_capped(
    mut res: reqwest::Response,
    max: usize,
) -> Result<Option<Vec<u8>>, reqwest::Error> {
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if body.len() + chunk.len() > max {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}
