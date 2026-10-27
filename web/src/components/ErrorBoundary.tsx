// The app's error boundaries. Around the app (`App`, and main.tsx's root as the last line of
// defence) a render error anywhere below leaves a message and a way back on screen instead of an
// empty page (React unmounts the whole tree on an uncaught error). Around one panel of the
// viewer (`region`: the 3D view, the radar, a HUD widget) it keeps that panel's error to itself:
// the panel gives way to a quiet note naming it, the error goes to the console, and the rest
// stays on screen and plays on: the clock and the sound are DemoView's, not any panel's. A new
// `resetKey` (a new pack, the next round, a new route) tries again; a panel that only a new page
// brings back (the 3D view: a chunk that will not load stays failed for the page) says so.

import {
  Component,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { messageOf } from '../errors';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: ReactNode;
  /** The panel this boundary keeps, as its note names it ("the round bar"); none at the root. */
  region?: string;
  /** Placement for the panel's note, from the layout it sits in. */
  className?: string;
  /** When this changes, a failed panel renders its children again. */
  resetKey?: unknown;
  /** Whether the panel's note offers to reload the page. */
  reload?: boolean;
}

/** Reloads the page at the moment it is at now, not the one the note's link was drawn at. */
function reloadNow(e: MouseEvent) {
  e.preventDefault();
  window.location.reload();
}

interface State {
  error: string | null;
  resetKey: unknown;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(e: unknown): Partial<State> {
    return { error: messageOf(e) };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State
  ): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(e: unknown, info: ErrorInfo) {
    const where = this.props.region ? ` in ${this.props.region}` : '';
    console.error(`demoviewer: render error${where}`, e, info.componentStack);
  }

  render() {
    const { error } = this.state;
    const { region, className, reload } = this.props;
    if (error === null) return this.props.children;
    if (region !== undefined)
      return (
        <p
          className={className ? `${styles.note} ${className}` : styles.note}
          role="status"
          title={error}
          data-testid="panel-error"
        >
          {region} stopped working
          {reload && (
            <>
              {' · '}
              <a href={window.location.href} onClick={reloadNow}>
                reload the page
              </a>
            </>
          )}
        </p>
      );
    return (
      <div className={styles.screen}>
        <div className={styles.panel} role="alert">
          <p className={styles.title}>Something went wrong</p>
          <p className={styles.text}>{error}</p>
          <a className={styles.link} href={window.location.href}>
            Reload the page
          </a>
        </div>
      </div>
    );
  }
}
