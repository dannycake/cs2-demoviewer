// Tournaments: `GET /api/events` (the list), `GET /api/events/{slug}` (one with its matches) and
// `GET /api/home` (the few the home page links). Field for field the server's
// (server/crates/server/src/events.rs).

import { errorOf } from './demos';

export interface EventSummary {
  slug: string;
  name: string;
  matches: number;
  /** Its first and last day; null when nothing says. */
  firstUnix: number | null;
  lastUnix: number | null;
}

export interface EventMatch {
  demoId: string;
  map: string;
  title: string;
  /** The winner's first. */
  score: [number, number];
  /** Null for a demo that does not say when it was played. */
  playedUnix: number | null;
  /** The two teams, when the corpus named them. */
  teams?: [string, string];
  /** The match's top fragger. */
  top: string | null;
}

export interface EventPage {
  event: EventSummary;
  matches: EventMatch[];
}

export interface HomeLinks {
  /** At most five. */
  events: EventSummary[];
}

export async function getEvents(): Promise<EventSummary[]> {
  const res = await fetch('/api/events');
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as EventSummary[];
}

/** Throws an `ApiError` with status 404 for an event the server does not have. */
export async function getEvent(slug: string): Promise<EventPage> {
  const res = await fetch(`/api/events/${encodeURIComponent(slug)}`);
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as EventPage;
}

export async function getHomeLinks(): Promise<HomeLinks> {
  const res = await fetch('/api/home');
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as HomeLinks;
}
