//! The preview image of a match page (`og:image`, see [`crate::pages`]): a 1200×630 JPEG card.
//! CS2's own screenshot of the map (`hero.png`, built by `tools/hero.sh`) fills it, darkened so
//! the text reads; a map without one gets its radar, faint, on the right. Over it: the site's
//! name and when the match was played, the map, the final score (each team's number in the
//! colour of the side it finished on, the winner's first), every round as a square in its
//! winner's colour with a gap at each half, and both teams' players, the winners on the left,
//! with kills, deaths and ADR; the match's top fragger in the team's colour. Names come from
//! the demo: a glyph the font lacks (CJK, Arabic, emoji) is left out, a name too wide is set
//! smaller, then cut, and one left with nothing is a dash.

use ab_glyph::{point, Font, FontRef, GlyphId, PxScale, ScaleFont};
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use tiny_skia::{
    BlendMode, Color, FilterQuality, GradientStop, LinearGradient, Paint, Pixmap, PixmapPaint,
    Point, Rect, SpreadMode, Transform,
};

use crate::matches::{MatchSummary, SummaryPlayer, MAX_SUMMARY_ROUNDS};
use crate::pages::{final_score, map_name, match_date, SITE_NAME};

pub const WIDTH: u32 = 1200;
pub const HEIGHT: u32 = 630;

/// JetBrains Mono 2.304, Bold and Medium (SIL Open Font License 1.1, `fonts/OFL.txt`): the
/// web app's face, in the weights its HUD uses for figures and for text.
static BOLD: &[u8] = include_bytes!("../fonts/JetBrainsMono-Bold.ttf");
static MEDIUM: &[u8] = include_bytes!("../fonts/JetBrainsMono-Medium.ttf");

/// The web app's tokens (`web/src/styles/tokens.css`): the ground, a hairline, three text
/// greys and the CS2 team colours.
const INK: Rgb = Rgb(0x00, 0x00, 0x00);
const LINE: Rgb = Rgb(0x3a, 0x36, 0x30);
const TEXT: Rgb = Rgb(0xe6, 0xe8, 0xef);
const TEXT_DIM: Rgb = Rgb(0x9a, 0xa1, 0xb2);
const TEXT_MUTE: Rgb = Rgb(0x6b, 0x72, 0x80);
const T: Rgb = Rgb(0xf2, 0xa3, 0x3a);
const CT: Rgb = Rgb(0x4d, 0xa3, 0xff);

/// JPEG quality, with full-resolution colour so the team colours' edges stay sharp.
const QUALITY: u8 = 88;
/// The margin all round.
const MARGIN: f32 = 56.0;
/// How dark the screenshot is made under everything, and how much darker its lower part,
/// where the players are, gets (a gradient from [`FADE_FROM`] to the bottom).
const SHADE: f32 = 0.5;
const FADE: f32 = 0.66;
const FADE_FROM: f32 = 220.0;
/// How much of a radar shows when there is no screenshot.
const RADAR_OPACITY: f32 = 0.35;
/// Width of the space left of the score and map name: the screenshot shows right of it.
const TITLE_W: f32 = 720.0;
/// The round squares: their side, the gap between them and the extra gap at a half.
const CELL: f32 = 16.0;
const CELL_GAP: f32 = 4.0;
const HALF_GAP: f32 = 12.0;
/// The two teams' columns.
const COLUMN_GAP: f32 = 64.0;
const COLUMN_W: f32 = (WIDTH as f32 - 2.0 * MARGIN - COLUMN_GAP) / 2.0;
/// The most players a column lists (a competitive team; Wingman has two).
const ROWS: usize = 5;
const ROW_PX: f32 = 26.0;
const ROW_STEP: f32 = 42.0;

#[derive(Clone, Copy)]
struct Rgb(u8, u8, u8);

struct Fonts<'a> {
    bold: FontRef<'a>,
    medium: FontRef<'a>,
}

/// The JPEG of `m`'s preview over `hero` (the map's `hero.png`) or, without one, `radar` (its
/// `radar.png`); an image that is missing or not a PNG is left out.
pub fn render(
    m: &MatchSummary,
    hero: Option<&[u8]>,
    radar: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let fonts = Fonts {
        bold: FontRef::try_from_slice(BOLD).map_err(|e| e.to_string())?,
        medium: FontRef::try_from_slice(MEDIUM).map_err(|e| e.to_string())?,
    };
    let mut image = Pixmap::new(WIDTH, HEIGHT).ok_or("cannot allocate the image")?;
    image.fill(color(INK));
    let decode = |png: &[u8], what: &str| {
        Pixmap::decode_png(png)
            .map_err(|e| tracing::warn!(map = %m.map, error = %e, "{what} is not a PNG; preview without it"))
            .ok()
    };
    if let Some(hero) = hero.and_then(|png| decode(png, "the hero image")) {
        backdrop(&mut image, &hero);
    } else if let Some(radar) = radar.and_then(|png| decode(png, "the radar")) {
        let side = HEIGHT as f32;
        let paint = PixmapPaint {
            opacity: RADAR_OPACITY,
            blend_mode: BlendMode::SourceOver,
            quality: FilterQuality::Bicubic,
        };
        let fit = Transform::from_scale(side / radar.width() as f32, side / radar.height() as f32)
            .post_translate(WIDTH as f32 - side, 0.0);
        image.draw_pixmap(0, 0, radar.as_ref(), &paint, fit, None);
    }

    let f = &fonts;
    // The site's name, and when and for how long the match was played.
    draw(
        &mut image, &f.medium, SITE_NAME, 24.0, MARGIN, 76.0, TEXT_DIM,
    );
    let when = match m.duration_s / 60 {
        0 => match_date(m),
        min => format!("{} · {min} min", match_date(m)),
    };
    draw_right(
        &mut image,
        &f.medium,
        &when,
        24.0,
        WIDTH as f32 - MARGIN,
        76.0,
        TEXT_DIM,
    );

    let (px, map) = fit(&f.bold, &map_name(&m.map), 64.0, 36.0, TITLE_W);
    draw(&mut image, &f.bold, &map, px, MARGIN, 160.0, TEXT);
    // The score, with a bar between the numbers: the face's dash fills its whole cell and
    // touches the digits at this size.
    let [(a, side_a), (b, side_b)] = final_score(m);
    let x = draw(
        &mut image,
        &f.bold,
        &a.to_string(),
        128.0,
        MARGIN - 6.0,
        282.0,
        side(side_a),
    );
    fill(&mut image, x + 18.0, 282.0 - 50.0, 40.0, 10.0, TEXT_MUTE);
    draw(
        &mut image,
        &f.bold,
        &b.to_string(),
        128.0,
        x + 76.0,
        282.0,
        side(side_b),
    );
    rounds(&mut image, m, 306.0);

    let top = top_fragger(m);
    for (i, team) in [side_a, side_b].into_iter().enumerate() {
        let x = MARGIN + i as f32 * (COLUMN_W + COLUMN_GAP);
        column(&mut image, f, m, team, top, x, 380.0);
    }

    jpeg(&image)
}

/// The screenshot, darkened all over and more towards the bottom, where the players are.
fn backdrop(image: &mut Pixmap, hero: &Pixmap) {
    let paint = PixmapPaint {
        opacity: 1.0,
        blend_mode: BlendMode::SourceOver,
        quality: FilterQuality::Bicubic,
    };
    let fit = Transform::from_scale(
        WIDTH as f32 / hero.width() as f32,
        HEIGHT as f32 / hero.height() as f32,
    );
    image.draw_pixmap(0, 0, hero.as_ref(), &paint, fit, None);
    let whole = Rect::from_xywh(0.0, 0.0, WIDTH as f32, HEIGHT as f32);
    let mut shade = Paint::default();
    shade.set_color(Color::from_rgba(0.0, 0.0, 0.0, SHADE).unwrap_or(Color::BLACK));
    if let Some(r) = whole {
        image.fill_rect(r, &shade, Transform::identity(), None);
    }
    let fade = LinearGradient::new(
        Point::from_xy(0.0, FADE_FROM),
        Point::from_xy(0.0, HEIGHT as f32),
        vec![
            GradientStop::new(
                0.0,
                Color::from_rgba(0.0, 0.0, 0.0, 0.0).unwrap_or(Color::TRANSPARENT),
            ),
            GradientStop::new(
                1.0,
                Color::from_rgba(0.0, 0.0, 0.0, FADE).unwrap_or(Color::BLACK),
            ),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    );
    if let (Some(shader), Some(r)) = (fade, whole) {
        let paint = Paint {
            shader,
            ..Paint::default()
        };
        image.fill_rect(r, &paint, Transform::identity(), None);
    }
}

/// Every round as a square in its winner's colour (grey without one), from `MARGIN` at `top`,
/// a wider gap before each half; squares shrink when the rounds would not fit the width.
fn rounds(image: &mut Pixmap, m: &MatchSummary, top: f32) {
    let n = m.round_winners.len().min(MAX_SUMMARY_ROUNDS);
    if n == 0 {
        return;
    }
    // The halves in order (as summaries keep them), walked once beside the rounds.
    let mut halves_at = m
        .swaps
        .iter()
        .map(|&s| usize::from(s))
        .filter(|&s| s < n)
        .peekable();
    let halves = m.swaps.iter().filter(|&&r| usize::from(r) < n).count() as f32;
    let room = WIDTH as f32 - 2.0 * MARGIN - halves * HALF_GAP;
    let step = (room / n as f32).min(CELL + CELL_GAP);
    let cell = (step * CELL / (CELL + CELL_GAP)).max(2.0);
    let mut x = MARGIN;
    for (r, &winner) in m.round_winners.iter().take(n).enumerate() {
        while halves_at.next_if(|&s| s <= r).is_some_and(|s| s == r) {
            x += HALF_GAP;
        }
        let c = match winner {
            2 => T,
            3 => CT,
            _ => TEXT_MUTE,
        };
        fill(image, x, top, cell, cell, c);
        x += step;
    }
}

/// The match's top fragger: most kills, then most damage; none without a kill.
fn top_fragger(m: &MatchSummary) -> Option<&SummaryPlayer> {
    m.players
        .iter()
        .filter(|p| p.kills > 0 && matches!(p.team, 2 | 3))
        .max_by_key(|p| (p.kills, p.damage))
}

/// The players who finished on `team`, most kills first, as a column from `x`: a header of the
/// side's colour and the figures' labels on `y`, then a row each.
fn column(
    image: &mut Pixmap,
    f: &Fonts,
    m: &MatchSummary,
    team: u8,
    top: Option<&SummaryPlayer>,
    x: f32,
    y: f32,
) {
    let mut players: Vec<&SummaryPlayer> = m.players.iter().filter(|p| p.team == team).collect();
    players.sort_by(|a, b| (b.kills, b.damage, a.deaths).cmp(&(a.kills, a.damage, b.deaths)));
    let right = x + COLUMN_W;
    let (k_x, d_x, adr_x) = (right - 168.0, right - 92.0, right);
    let label = if team == 2 { "T" } else { "CT" };
    draw(image, &f.bold, label, 20.0, x, y, side(team));
    for (text, at) in [("K", k_x), ("D", d_x), ("ADR", adr_x)] {
        draw_right(image, &f.medium, text, 20.0, at, y, TEXT_DIM);
    }
    fill(image, x, y + 12.0, COLUMN_W, 1.0, LINE);
    let rounds = f32::from(m.rounds.max(1));
    for (i, p) in players.iter().take(ROWS).enumerate() {
        let base = y + 44.0 + i as f32 * ROW_STEP;
        let best = top.is_some_and(|t| std::ptr::eq(t, *p));
        let font = if best { &f.bold } else { &f.medium };
        let (px, name) = fit(font, &p.name, ROW_PX, 18.0, k_x - x - 80.0);
        let name = if name.is_empty() {
            "–".to_owned()
        } else {
            name
        };
        draw(
            image,
            font,
            &name,
            px,
            x,
            base,
            if best { side(team) } else { TEXT },
        );
        draw_right(
            image,
            &f.bold,
            &p.kills.to_string(),
            ROW_PX,
            k_x,
            base,
            TEXT,
        );
        draw_right(
            image,
            &f.medium,
            &p.deaths.to_string(),
            ROW_PX,
            d_x,
            base,
            TEXT_DIM,
        );
        let adr = if p.damage > 0 || p.kills == 0 {
            format!("{:.0}", p.damage as f32 / rounds)
        } else {
            "–".to_owned()
        };
        draw_right(image, &f.medium, &adr, ROW_PX, adr_x, base, TEXT_DIM);
    }
}

fn fill(image: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, c: Rgb) {
    let mut paint = Paint::default();
    paint.set_color(color(c));
    if let Some(r) = Rect::from_xywh(x, y, w, h) {
        image.fill_rect(r, &paint, Transform::identity(), None);
    }
}

/// The opaque image as a baseline JPEG, colour at full resolution.
fn jpeg(image: &Pixmap) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = image
        .data()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|&[r, g, b, _]| [r, g, b])
        .collect();
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, QUALITY);
    encoder.set_sampling_factor(SamplingFactor::R_4_4_4);
    let (w, h) = (WIDTH as u16, HEIGHT as u16);
    encoder
        .encode(&rgb, w, h, ColorType::Rgb)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn color(c: Rgb) -> Color {
    Color::from_rgba8(c.0, c.1, c.2, 255)
}

fn side(team: u8) -> Rgb {
    if team == 2 {
        T
    } else {
        CT
    }
}

/// The scale at which the font's em is `px` pixels (ab_glyph scales by ascent to descent).
fn scale(font: &FontRef, px: f32) -> PxScale {
    let em = font.units_per_em().unwrap_or(1000.0);
    PxScale::from(px * font.height_unscaled() / em)
}

/// The glyphs of `text` the font has; characters it lacks, and control characters, are left
/// out.
fn glyphs<'a>(font: &'a FontRef, text: &'a str) -> impl Iterator<Item = GlyphId> + 'a {
    text.chars()
        .filter(|c| !c.is_control())
        .map(|c| font.glyph_id(c))
        .filter(|id| id.0 != 0)
}

/// `text` as the font sets it: the characters it lacks, and control characters, left out, and
/// the spaces around them closed up, so a name that starts with one is not indented.
fn settable(font: &FontRef, text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|&c| !c.is_control() && font.glyph_id(c).0 != 0)
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How wide `text` is at `px` pixels to the em.
fn width(font: &FontRef, text: &str, px: f32) -> f32 {
    let scaled = font.as_scaled(scale(font, px));
    let mut w = 0.0;
    let mut prev = None;
    for id in glyphs(font, text) {
        if let Some(p) = prev {
            w += scaled.kern(p, id);
        }
        w += scaled.h_advance(id);
        prev = Some(id);
    }
    w
}

/// The largest size from `max` down to `min` at which `text` fits in `room` pixels, and the
/// text as the font sets it ([`settable`]); at `min`, it is cut and ends in "…" until it fits.
fn fit(font: &FontRef, text: &str, max: f32, min: f32, room: f32) -> (f32, String) {
    let text = settable(font, text);
    let w = width(font, &text, max);
    if w <= room {
        return (max, text);
    }
    // Widths grow linearly with the size.
    let px = (max * room / w).floor().max(min);
    if width(font, &text, px) <= room {
        return (px, text);
    }
    let chars: Vec<char> = text.chars().collect();
    let cut = (0..chars.len())
        .rev()
        .map(|n| format!("{}…", chars[..n].iter().collect::<String>().trim_end()))
        .find(|cut| width(font, cut, px) <= room)
        .unwrap_or_default();
    (px, cut)
}

/// Draws `text` at `px` pixels to the em from `x` on the baseline `y`, and returns where the
/// pen stops. The image is opaque, so coverage blends straight into its colour.
fn draw(image: &mut Pixmap, font: &FontRef, text: &str, px: f32, x: f32, y: f32, c: Rgb) -> f32 {
    let scale = scale(font, px);
    let scaled = font.as_scaled(scale);
    let (w, h) = (i64::from(image.width()), i64::from(image.height()));
    let data = image.data_mut();
    let mut pen = x;
    let mut prev = None;
    for id in glyphs(font, text) {
        if let Some(p) = prev {
            pen += scaled.kern(p, id);
        }
        if let Some(outline) = font.outline_glyph(id.with_scale_and_position(scale, point(pen, y)))
        {
            let min = outline.px_bounds().min;
            outline.draw(|gx, gy, coverage| {
                let (px, py) = (min.x as i64 + i64::from(gx), min.y as i64 + i64::from(gy));
                if px < 0 || py < 0 || px >= w || py >= h {
                    return;
                }
                let i = usize::try_from((py * w + px) * 4).unwrap_or(usize::MAX);
                let a = coverage.clamp(0.0, 1.0);
                for (k, to) in [c.0, c.1, c.2].into_iter().enumerate() {
                    if let Some(d) = data.get_mut(i + k) {
                        let from = f32::from(*d);
                        *d = (from + (f32::from(to) - from) * a).round() as u8;
                    }
                }
            });
        }
        pen += scaled.h_advance(id);
        prev = Some(id);
    }
    pen
}

/// [`draw`] with the text ending at `right`.
fn draw_right(
    image: &mut Pixmap,
    font: &FontRef,
    text: &str,
    px: f32,
    right: f32,
    y: f32,
    c: Rgb,
) -> f32 {
    draw(image, font, text, px, right - width(font, text, px), y, c)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The old title column's width, which these sizes were chosen for.
    const ROOM: f32 = 442.0;

    fn font() -> FontRef<'static> {
        FontRef::try_from_slice(BOLD).unwrap()
    }

    #[test]
    fn missing_glyphs_take_no_room() {
        let f = font();
        assert_eq!(width(&f, "東京🙂\u{0}", 50.0), 0.0);
        assert_eq!(width(&f, "a東b", 50.0), width(&f, "ab", 50.0));
        // Monospace: 0.6 em a character.
        assert!((width(&f, "Mirage", 100.0) - 360.0).abs() < 1.0);
    }

    #[test]
    fn text_too_wide_is_set_smaller_then_cut() {
        let f = font();
        assert_eq!(fit(&f, "Nuke", 76.0, 36.0, ROOM), (76.0, "Nuke".to_owned()));
        let (px, text) = fit(&f, "Cobblestone", 76.0, 36.0, ROOM);
        assert!((36.0..76.0).contains(&px), "{px}");
        assert_eq!(text, "Cobblestone");
        let (px, text) = fit(&f, &"w".repeat(100), 76.0, 36.0, ROOM);
        assert_eq!(px, 36.0);
        assert!(text.ends_with('…') && text.chars().count() < 100, "{text}");
        assert!(width(&f, &text, px) <= ROOM);
    }

    #[test]
    fn missing_glyphs_leave_no_blank() {
        let f = font();
        assert_eq!(
            fit(&f, "東京🙂 Mirage", 76.0, 36.0, ROOM),
            (76.0, "Mirage".to_owned())
        );
        assert_eq!(fit(&f, "a 東 b\u{0} ", 76.0, 36.0, ROOM).1, "a b");
        assert_eq!(fit(&f, "東京🙂", 76.0, 36.0, ROOM).1, "");
        let (_, cut) = fit(
            &f,
            "東京🙂 long workshop map name that is wide",
            76.0,
            36.0,
            ROOM,
        );
        assert!(cut.starts_with("long ") && cut.ends_with('…'), "{cut:?}");
    }
}
