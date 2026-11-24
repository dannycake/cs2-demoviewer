//! The preview image of a match page (`og:image`, see [`crate::pages`]): a 1200×630 JPEG card.
//! CS2's own screenshot of the map (`hero.png`, built by `tools/hero.sh`) fills it, darkened so
//! the text reads; a map without one gets its radar, faint, on the right. Over it: the site's
//! name and when the match was played, the map, the final score (each team's number in the
//! colour of the side it finished on, the winner's first), every round as a square in its
//! winner's colour with a gap at each half, and both teams' players, the winners on the left,
//! with kills, deaths and ADR; the match's top fragger in the team's colour. Names come from
//! the demo: a glyph the font lacks (CJK, Arabic, emoji) is left out, a name too wide is set
//! smaller, then cut, and one left with nothing is a dash.
//!
//! A player's card ([`render_profile`]) is the same size on the site's black, over the
//! screenshot of the map they play most when there is one: their avatar (or the page's person
//! without one), their name, their Premier rating in its tier's colour, and the figures of the
//! profile's stat strip it knows, in its rainbow (`web/src/site/format.ts`), each as far from the
//! next as the width allows. A player with no match yet has no strip: they stand in the middle,
//! "0 matches" under their name.

use ab_glyph::{point, Font, FontRef, GlyphId, PxScale, ScaleFont};
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, LinearGradient, Paint, PathBuilder,
    Pixmap, PixmapPaint, Point, Rect, SpreadMode, Transform,
};

use crate::matches::{MatchSummary, SummaryPlayer, MAX_SUMMARY_ROUNDS};
use crate::pages::{
    as_sent, final_score, fixed, map_name, match_date, opening_pct, thousands, SITE_NAME,
};
use crate::profile::ProfileView;

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
/// The stat strip's colours, rating first (`RAINBOW` in `web/src/site/format.ts`).
const RAINBOW: [Rgb; 6] = [
    Rgb(0xff, 0x4d, 0x5e),
    Rgb(0xff, 0x9a, 0x3c),
    Rgb(0xff, 0xd8, 0x4d),
    Rgb(0x4b, 0xe0, 0x8a),
    Rgb(0x4c, 0xc3, 0xff),
    Rgb(0xb9, 0x8c, 0xff),
];
/// A Premier rating's colour, a band every 5,000 as CS2 draws it (`PREMIER_COLOURS`).
const PREMIER: [Rgb; 7] = [
    Rgb(0xb0, 0xc3, 0xd9),
    Rgb(0x8c, 0xc6, 0xff),
    Rgb(0x6a, 0x7d, 0xff),
    Rgb(0xc1, 0x66, 0xff),
    Rgb(0xf0, 0x3c, 0xff),
    Rgb(0xeb, 0x4b, 0x4b),
    Rgb(0xfe, 0xd7, 0x00),
];
/// The site's hairline and its grey for marks (`--line`, `--mark` in `web/src/site/tokens.css`):
/// the square of a player without an avatar, and the person in it.
const SITE_LINE: Rgb = Rgb(0x26, 0x26, 0x26);
const MARK: Rgb = Rgb(0x66, 0x66, 0x66);
/// The stat strip's labels, as the profile page's.
const STAT_LABELS: [&str; 6] = ["rating", "opening", "K/D", "ADR", "HS%", "matches"];
/// How a player's card is drawn: part of the key it is kept under (`crate::pages`), so a
/// change here that shows is drawn again. Raise it with any such change.
pub const PROFILE_DESIGN: u32 = 5;
/// How a match's card is drawn, written into its JPEG (an APP15 segment): a card kept without
/// it is from an older look, and `crate::pages` draws it again. Raise it with any change to
/// [`render`] that shows (2: the day as the site writes it, a half rounded away from zero).
pub const MATCH_DESIGN: &[u8] = b"skunk.club match card 3";
/// The strip's figures: their largest and smallest size, the least room between two, and their
/// labels' size.
const FIGURE_PX: f32 = 60.0;
const FIGURE_MIN_PX: f32 = 32.0;
const FIGURE_GAP: f32 = 40.0;
const LABEL_PX: f32 = 26.0;
/// The side of a player's avatar on their card, and how far their name sits from it.
const AVATAR: f32 = 176.0;
const AVATAR_GAP: f32 = 36.0;
/// How large a percentage's sign is beside its figure (`.pct` in `web/src/site/tokens.css`).
const PCT: f32 = 0.72;
/// The largest avatar drawn (Steam's full-size ones are 184 pixels square).
const AVATAR_MAX_SIDE: u16 = 1024;

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
/// How much darker still a player's card makes the screenshot: the text is the card.
const PROFILE_SHADE: f32 = 0.55;
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
    let when = [
        match_date(m),
        match m.duration_s / 60 {
            0 => String::new(),
            min => format!("{min} min"),
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
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

    jpeg(&image, Some(MATCH_DESIGN))
}

/// What a player's card shows: everything [`render_profile`] draws, so a card is drawn again
/// exactly when one of these changes.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileCard {
    pub name: String,
    /// Their Premier rating, when they have one.
    pub premier: Option<u32>,
    /// The stat strip as the profile page writes it: rating, opening duels won, K/D, ADR, HS%
    /// and matches, "—" for what is unknown.
    pub stats: [String; 6],
    /// The map they play most (`de_mirage`), whose screenshot is the card's ground.
    pub map: Option<String>,
    /// Steam's address of the avatar it shows, when its image is kept.
    pub avatar: Option<String>,
}

impl ProfileCard {
    /// The card of `view`, named `name`; with their avatar when its image is kept
    /// (`avatar_kept`).
    pub fn of(view: &ProfileView, name: &str, avatar_kept: bool) -> Self {
        let t = &view.totals;
        let dash = || "—".to_owned();
        // As the page writes them (`fixed`): a half away from zero.
        let sent = |x: Option<f32>, places| x.map_or_else(dash, |x| fixed(as_sent(x), places));
        let opening =
            opening_pct(t.opening_won, t.opening_lost).map(|won| format!("{}%", fixed(won, 0)));
        Self {
            name: name.to_owned(),
            premier: view.premier.as_ref().map(|p| p.rating).filter(|&r| r > 0),
            stats: [
                sent(t.rating, 2),
                opening.unwrap_or_else(dash),
                sent(t.kd, 2),
                sent(t.adr, 0),
                sent(t.hs_pct, 0),
                t.matches.to_string(),
            ],
            map: view.maps.first().map(|m| m.map.clone()),
            avatar: view.avatar.clone().filter(|_| avatar_kept),
        }
    }
}

/// The labels of a card's stat strip (`ProfileCard::stats`): "match" for one, as the page says.
fn stat_labels(stats: &[String; 6]) -> [&'static str; 6] {
    let mut labels = STAT_LABELS;
    if stats[5] == "1" {
        labels[5] = "match";
    }
    labels
}

/// The JPEG of a player's card over `hero` (the `hero.png` of the map they play most), black
/// without one, with `avatar` (their avatar's JPEG) left of their name; an avatar that is not a
/// JPEG is left out.
pub fn render_profile(
    card: &ProfileCard,
    hero: Option<&[u8]>,
    avatar: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let f = &Fonts {
        bold: FontRef::try_from_slice(BOLD).map_err(|e| e.to_string())?,
        medium: FontRef::try_from_slice(MEDIUM).map_err(|e| e.to_string())?,
    };
    let mut image = Pixmap::new(WIDTH, HEIGHT).ok_or("cannot allocate the image")?;
    image.fill(color(INK));
    let hero = hero.and_then(|png| {
        Pixmap::decode_png(png)
            .map_err(|e| tracing::warn!(map = ?card.map, error = %e, "the hero image is not a PNG; card without it"))
            .ok()
    });
    if let Some(hero) = hero {
        backdrop(&mut image, &hero);
        darken(&mut image, PROFILE_SHADE);
    }
    let right = WIDTH as f32 - MARGIN;
    draw(
        &mut image, &f.medium, SITE_NAME, 24.0, MARGIN, 76.0, TEXT_DIM,
    );

    // The avatar, a square (the page's person without one), with the name and the line under
    // it beside it; with no strip under them (no match yet), in the card's middle.
    let columns = strip(f, card);
    let top = if columns.is_empty() {
        (HEIGHT as f32 - AVATAR) / 2.0
    } else {
        116.0
    };
    let avatar = avatar.and_then(|jpeg| {
        avatar_pixmap(jpeg)
            .map_err(
                |e| tracing::warn!(error = %e, "an avatar that is not a JPEG; card without it"),
            )
            .ok()
    });
    match &avatar {
        Some(avatar) => {
            let paint = PixmapPaint {
                opacity: 1.0,
                blend_mode: BlendMode::SourceOver,
                quality: FilterQuality::Bicubic,
            };
            let fit = Transform::from_scale(
                AVATAR / avatar.width() as f32,
                AVATAR / avatar.height() as f32,
            )
            .post_translate(MARGIN, top);
            image.draw_pixmap(0, 0, avatar.as_ref(), &paint, fit, None);
        }
        None => person(&mut image, MARGIN, top),
    }
    let (left, name_y, line_y) = (MARGIN + AVATAR + AVATAR_GAP, top + 94.0, top + 150.0);
    let (px, name) = fit(&f.bold, &card.name, 96.0, 44.0, right - left);
    let name = if name.is_empty() {
        "–".to_owned()
    } else {
        name
    };
    draw(&mut image, &f.bold, &name, px, left, name_y, TEXT);
    // Under the name: the Premier rating, and the map behind it.
    let mut x = left;
    if let Some(rating) = card.premier {
        x = draw(&mut image, &f.medium, "Premier ", 30.0, x, line_y, TEXT_DIM);
        let tier = (rating / 5000).min(6) as usize;
        x = draw(
            &mut image,
            &f.bold,
            &thousands(rating),
            30.0,
            x,
            line_y,
            PREMIER[tier],
        );
        x += 40.0;
    }
    if let Some(map) = &card.map {
        x = draw(
            &mut image,
            &f.medium,
            "Most played ",
            30.0,
            x,
            line_y,
            TEXT_DIM,
        );
        draw(&mut image, &f.medium, &map_name(map), 30.0, x, line_y, TEXT);
    }
    if columns.is_empty() {
        let label = stat_labels(&card.stats)[5];
        x = draw(&mut image, &f.bold, &card.stats[5], 30.0, x, line_y, TEXT);
        draw(
            &mut image,
            &f.medium,
            &format!(" {label}"),
            30.0,
            x,
            line_y,
            TEXT_DIM,
        );
    } else {
        // The stat strip over a hairline: each figure in its colour, its label under it.
        let top = 420.0;
        fill(&mut image, MARGIN, top, right - MARGIN, 1.0, LINE);
        for c in &columns {
            let colour = RAINBOW[c.colour];
            figure(
                &mut image,
                &f.bold,
                &c.value,
                c.px,
                c.x,
                top + 100.0,
                colour,
            );
            draw(
                &mut image,
                &f.medium,
                c.label,
                LABEL_PX,
                c.x,
                top + 148.0,
                TEXT_DIM,
            );
        }
    }

    jpeg(&image, None)
}

/// One figure of a card's stat strip, where it is set: from `x`, at `px`; `colour` is its place
/// in the strip's rainbow.
struct Column {
    x: f32,
    px: f32,
    value: String,
    label: &'static str,
    colour: usize,
}

/// The figures of the card's stat strip it knows (one unknown, "—", is left out), the first at
/// the margin and the last ending at the right one, as far apart as that leaves, at one size: the
/// largest at which they stand at least [`FIGURE_GAP`] apart. None for a player with no match.
fn strip(f: &Fonts, card: &ProfileCard) -> Vec<Column> {
    if card.stats[5] == "0" {
        return Vec::new();
    }
    let known: Vec<(usize, &str, &'static str)> = card
        .stats
        .iter()
        .zip(stat_labels(&card.stats))
        .enumerate()
        .filter(|(_, (value, _))| value.as_str() != "—")
        .map(|(i, (value, label))| (i, value.as_str(), label))
        .collect();
    let room = WIDTH as f32 - 2.0 * MARGIN;
    let widths = |px: f32| -> Vec<f32> {
        known
            .iter()
            .map(|(_, value, label)| {
                figure_width(&f.bold, value, px).max(width(&f.medium, label, LABEL_PX))
            })
            .collect()
    };
    let between = known.len().saturating_sub(1) as f32;
    let mut px = FIGURE_PX;
    while px > FIGURE_MIN_PX && widths(px).iter().sum::<f32>() + between * FIGURE_GAP > room {
        px -= 2.0;
    }
    let widths = widths(px);
    let gap = if between > 0.0 {
        (room - widths.iter().sum::<f32>()) / between
    } else {
        0.0
    };
    let mut x = MARGIN;
    known
        .into_iter()
        .zip(widths)
        .map(|((colour, value, label), width)| {
            let column = Column {
                x,
                px,
                value: value.to_owned(),
                label,
                colour,
            };
            x += width + gap;
            column
        })
        .collect()
}

/// The page's person, a missing avatar's glyph (`Who.tsx`), in a black square of the avatar's
/// side at (`x`, `y`) with a hairline round it, as the page draws its avatar's cell.
fn person(image: &mut Pixmap, x: f32, y: f32) {
    fill(image, x, y, AVATAR, AVATAR, INK);
    for (lx, ly, w, h) in [
        (x, y, AVATAR, 1.0),
        (x, y + AVATAR - 1.0, AVATAR, 1.0),
        (x, y, 1.0, AVATAR),
        (x + AVATAR - 1.0, y, 1.0, AVATAR),
    ] {
        fill(image, lx, ly, w, h, SITE_LINE);
    }
    // Its 24-unit drawing at 46% of the square, in the middle.
    let s = AVATAR * 0.46 / 24.0;
    let at = |u: f32, v: f32| {
        let o = (AVATAR - 24.0 * s) / 2.0;
        (x + o + u * s, y + o + v * s)
    };
    let mut path = PathBuilder::new();
    let (cx, cy) = at(12.0, 8.0);
    path.push_circle(cx, cy, 4.5 * s);
    let (x0, y0) = at(3.0, 21.0);
    path.move_to(x0, y0);
    for [a, b, c] in [
        [(3.0, 16.6), (7.0, 14.0), (12.0, 14.0)],
        [(17.0, 14.0), (21.0, 16.6), (21.0, 21.0)],
    ] {
        let ((ax, ay), (bx, by), (cx, cy)) = (at(a.0, a.1), at(b.0, b.1), at(c.0, c.1));
        path.cubic_to(ax, ay, bx, by, cx, cy);
    }
    path.close();
    if let Some(path) = path.finish() {
        let mut paint = Paint::default();
        paint.set_color(color(MARK));
        paint.anti_alias = true;
        image.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

/// How wide [`figure`] sets `text` at `px`.
fn figure_width(font: &FontRef, text: &str, px: f32) -> f32 {
    match text.strip_suffix('%') {
        Some(n) => width(font, n, px) + width(font, "%", px * PCT),
        None => width(font, text, px),
    }
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
    darken(image, SHADE);
    let whole = Rect::from_xywh(0.0, 0.0, WIDTH as f32, HEIGHT as f32);
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

/// An avatar's JPEG as an opaque image: greyscale or colour, at most [`AVATAR_MAX_SIDE`] a
/// side.
fn avatar_pixmap(jpeg: &[u8]) -> Result<Pixmap, String> {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    decoder.read_info().map_err(|e| e.to_string())?;
    let info = decoder.info().ok_or("no image")?;
    if info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE {
        return Err(format!("{}×{} is not an avatar", info.width, info.height));
    }
    let pixels = decoder.decode().map_err(|e| e.to_string())?;
    let rgba: Vec<u8> = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|&[r, g, b]| [r, g, b, 255])
            .collect(),
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&l| [l, l, l, 255]).collect(),
        other => return Err(format!("{other:?} pixels")),
    };
    let size = tiny_skia::IntSize::from_wh(u32::from(info.width), u32::from(info.height))
        .ok_or("an empty image")?;
    Pixmap::from_vec(rgba, size).ok_or_else(|| "the pixels do not fill the image".to_owned())
}

/// Black at `alpha` over the whole image.
fn darken(image: &mut Pixmap, alpha: f32) {
    let mut shade = Paint::default();
    shade.set_color(Color::from_rgba(0.0, 0.0, 0.0, alpha).unwrap_or(Color::BLACK));
    if let Some(r) = Rect::from_xywh(0.0, 0.0, WIDTH as f32, HEIGHT as f32) {
        image.fill_rect(r, &shade, Transform::identity(), None);
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
    let rounds = f64::from(m.rounds.max(1));
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
            fixed(f64::from(p.damage) / rounds, 0)
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

/// The opaque image as a baseline JPEG, colour at full resolution, with `design` (when given)
/// in an APP15 segment.
fn jpeg(image: &Pixmap, design: Option<&[u8]>) -> Result<Vec<u8>, String> {
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
    if let Some(design) = design {
        encoder
            .add_app_segment(15, design)
            .map_err(|e| e.to_string())?;
    }
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

/// [`draw`] for a figure: a percentage's sign set [`PCT`] as large, on the same baseline.
fn figure(image: &mut Pixmap, font: &FontRef, text: &str, px: f32, x: f32, y: f32, c: Rgb) -> f32 {
    match text.strip_suffix('%') {
        Some(n) => {
            let pen = draw(image, font, n, px, x, y, c);
            draw(image, font, "%", px * PCT, pen, y, c)
        }
        None => draw(image, font, text, px, x, y, c),
    }
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

    /// A percentage's sign is set smaller than its figure, as the profile page sets it.
    #[test]
    fn a_percent_sign_is_set_smaller_than_its_figure() {
        let f = font();
        let mut image = Pixmap::new(400, 100).unwrap();
        let whole = draw(&mut image, &f, "86%", 60.0, 0.0, 80.0, TEXT);
        let set = figure(&mut image, &f, "86%", 60.0, 0.0, 80.0, TEXT);
        assert!((whole - width(&f, "86%", 60.0)).abs() < 0.5);
        assert!(
            (set - (width(&f, "86", 60.0) + width(&f, "%", 60.0 * PCT))).abs() < 0.5,
            "{set}"
        );
        // Anything else as it is.
        let plain = figure(&mut image, &f, "1.59", 60.0, 0.0, 80.0, TEXT);
        assert!((plain - width(&f, "1.59", 60.0)).abs() < 0.5);
    }

    /// The card's figures are the page's: 102.5 ADR is "103", as `Math.round` writes it.
    #[test]
    fn the_cards_figures_round_as_the_page_does() {
        let mut view = crate::profile::build_profile(
            76_561_198_000_000_001,
            &[],
            None,
            crate::profile::TrackingState::Off,
            |_| false,
        );
        let t = &mut view.totals;
        (t.rating, t.kd, t.adr, t.hs_pct) = (Some(1.125), Some(1.375), Some(102.5), Some(60.5));
        (t.opening_won, t.opening_lost, t.matches) = (1, 7, 2);
        let card = ProfileCard::of(&view, "x", false);
        assert_eq!(card.stats, ["1.13", "13%", "1.38", "103", "61", "2"]);
    }

    fn card_of(stats: [&str; 6]) -> ProfileCard {
        ProfileCard {
            name: "F00L1SH_N1NJ4".into(),
            premier: None,
            stats: stats.map(String::from),
            map: None,
            avatar: None,
        }
    }

    /// The strip sets only the figures it knows, each as far from the next as the width allows
    /// (not at a fixed pitch, which set "1.10" 41 px from "82" and 110 px elsewhere): the first
    /// at the margin, the last ending at the right one.
    #[test]
    fn the_strip_spaces_its_figures_by_their_width() {
        let f = Fonts {
            bold: FontRef::try_from_slice(BOLD).unwrap(),
            medium: FontRef::try_from_slice(MEDIUM).unwrap(),
        };
        let cols = strip(&f, &card_of(["1.12", "52%", "1.10", "82", "61", "34"]));
        // A column is as wide as its figure or its label, the wider.
        let wide = |c: &Column| {
            figure_width(&f.bold, &c.value, c.px).max(width(&f.medium, c.label, LABEL_PX))
        };
        assert_eq!(cols.len(), 6);
        assert_eq!(cols[0].x, MARGIN);
        let last = &cols[5];
        assert!((last.x + wide(last) - (WIDTH as f32 - MARGIN)).abs() < 0.5);
        let gaps: Vec<f32> = cols
            .windows(2)
            .map(|w| w[1].x - (w[0].x + wide(&w[0])))
            .collect();
        assert!(
            gaps.iter().all(|g| (g - gaps[0]).abs() < 0.5 && *g >= 40.0),
            "{gaps:?}"
        );
        // Each figure keeps its colour; an unknown one is left out, not dashed.
        let cols = strip(&f, &card_of(["1.12", "—", "1.10", "82", "61", "34"]));
        let shown: Vec<_> = cols.iter().map(|c| (c.value.as_str(), c.label)).collect();
        assert_eq!(
            shown,
            [
                ("1.12", "rating"),
                ("1.10", "K/D"),
                ("82", "ADR"),
                ("61", "HS%"),
                ("34", "matches")
            ]
        );
        assert_eq!(cols[1].colour, 2);
        // No match, no strip: the line under the name says so.
        assert!(strip(&f, &card_of(["—", "—", "—", "—", "—", "0"])).is_empty());
    }

    /// A player without an avatar has the page's person in its place, so the name stands where
    /// it does beside an avatar.
    #[test]
    fn a_card_without_an_avatar_shows_the_person() {
        let jpeg = render_profile(&card_of(["—", "—", "—", "—", "—", "0"]), None, None).unwrap();
        let mut d = jpeg_decoder::Decoder::new(jpeg.as_slice());
        let rgb = d.decode().unwrap();
        let at = |x: usize, y: usize| {
            let i = (y * WIDTH as usize + x) * 3;
            (rgb[i], rgb[i + 1], rgb[i + 2])
        };
        let (left, top) = (MARGIN as usize, ((HEIGHT as f32 - AVATAR) / 2.0) as usize);
        let side = AVATAR as usize;
        // The head, a third of the way down the square's middle; black around it.
        let head = at(left + side / 2, top + side * 41 / 100);
        assert!(
            head.0.abs_diff(MARK.0) < 24 && head.0.abs_diff(head.2) < 8,
            "{head:?}"
        );
        assert!(
            at(left + 10, top + 10).0 < 16,
            "{:?}",
            at(left + 10, top + 10)
        );
    }

    #[test]
    fn one_match_is_a_match() {
        let stats = |m: &str| ["1.10", "50%", "1.00", "80", "40", m].map(String::from);
        assert_eq!(stat_labels(&stats("1"))[5], "match");
        assert_eq!(stat_labels(&stats("34"))[5], "matches");
        assert_eq!(stat_labels(&stats("0"))[5], "matches");
        assert_eq!(stat_labels(&stats("1"))[..5], STAT_LABELS[..5]);
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
