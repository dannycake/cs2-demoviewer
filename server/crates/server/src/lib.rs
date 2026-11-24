//! demoviewer server library: demo parsing, URL ingest, share codes and their lookups, the demo
//! store, the job runner and its parse worker, match summaries, the rate limiter and the
//! admission of ingests, chunked uploads, the HTTP API and the match pages with their preview
//! images.

pub mod admission;
pub mod api;
pub mod app;
pub mod auth;
pub mod background;
pub mod config;
pub mod errors;
pub mod event_dates;
pub mod events;
pub mod faceit;
pub mod faceit_history;
pub mod faceit_tracker;
pub mod feed;
pub mod gcbot;
pub mod guides;
pub mod hidden;
pub mod history;
pub mod hosts;
mod http;
pub mod identity;
pub mod import;
pub mod indexnow;
pub mod ingest;
pub mod jobs;
pub mod matches;
pub mod me_api;
pub mod originals;
pub mod pages;
pub mod parse;
pub mod players;
pub mod players_api;
pub mod prerender;
pub mod preview;
pub mod profile;
pub mod profiles;
pub mod ratelimit;
pub mod rating;
pub mod seal;
pub mod sessions;
pub mod sharecode;
pub mod sitemap;
pub mod steam;
pub mod store;
pub mod structured;
pub mod tracker;
pub mod tracking;
pub mod uploads;
pub mod worker;
