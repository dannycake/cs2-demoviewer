//! demoviewer server library: demo parsing, URL ingest, share codes and their lookups, the demo
//! store, the job runner and its parse worker, match summaries, the rate limiter and the
//! admission of ingests, chunked uploads, the HTTP API and the match pages with their preview
//! images.

pub mod admission;
pub mod api;
pub mod app;
pub mod config;
pub mod errors;
pub mod gcbot;
pub mod ingest;
pub mod jobs;
pub mod matches;
pub mod pages;
pub mod parse;
pub mod preview;
pub mod ratelimit;
pub mod sharecode;
pub mod store;
pub mod uploads;
pub mod worker;
