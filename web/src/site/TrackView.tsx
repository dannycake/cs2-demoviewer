// Sharing match history (`/track`, where signing in through Steam ends): signed out, the sign-in
// button; signed in, the two steps on Steam's support page and the code and token (Steam's
// refusal goes under the field it names); once on, a confirmation, the profile, and a way to stop.
// "Tracking stopped" (Steam no longer takes the code) shows the form again. Sign-out is there in
// every signed-in state. The code is a credential: masked unless shown, and forgotten when the
// page is put away (left, or kept in the back-forward cache).

import { useEffect, useState, type FormEvent } from 'react';
import {
  signOut,
  startTracking,
  stopTracking,
  TrackingError,
  type Me,
} from '../api/me';
import { steamLogoUrl } from '../api/site-assets';
import { messageOf } from '../errors';
import { pageTitle } from '../router';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';
import SiteLink from './SiteLink';
import { useMe } from './use-me';
import { useSiteAssets } from './use-site-assets';
import styles from './TrackView.module.css';

const SUPPORT =
  'https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128';

type Field = 'authCode' | 'token' | 'olderToken';

function Input({
  id,
  label,
  placeholder,
  value,
  onChange,
  error,
  hint,
  secret,
}: {
  id: Field;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  /** Masked until shown (a credential). */
  secret?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const input = (
    <input
      id={id}
      className={styles.in}
      type={secret && !shown ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-invalid={error ? 'true' : 'false'}
      aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
    />
  );
  return (
    <div className={`${styles.field} ${error ? styles.bad : ''}`}>
      <label htmlFor={id}>{label}</label>
      {secret ? (
        <div className={styles.secret}>
          {input}
          <button
            type="button"
            className={styles.show}
            aria-label={shown ? 'Hide the code' : 'Show the code'}
            aria-controls={id}
            onClick={() => setShown(!shown)}
          >
            {shown ? 'Hide' : 'Show'}
          </button>
        </div>
      ) : (
        input
      )}
      {error && (
        <p className={styles.err} id={`${id}-error`}>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className={styles.hint} id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Form({
  me,
  onOn,
  onSignedOut,
}: {
  me: Me;
  onOn: () => void;
  onSignedOut: () => void;
}) {
  const [authCode, setAuthCode] = useState('');
  const [token, setToken] = useState('');
  const [olderToken, setOlderToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field | 'form', string>>>(
    {}
  );
  // A page put away (left, or kept in the back-forward cache) keeps no code in its field.
  useEffect(() => {
    const forget = () => setAuthCode('');
    window.addEventListener('pagehide', forget);
    return () => window.removeEventListener('pagehide', forget);
  }, []);

  const signOutHere = async () => {
    setErrors({});
    try {
      await signOut();
      onSignedOut();
    } catch (err) {
      setErrors({ form: messageOf(err) });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await startTracking({
        authCode,
        token,
        ...(olderToken.trim() ? { olderToken } : {}),
      });
      onOn();
    } catch (err) {
      if (err instanceof TrackingError && err.field)
        setErrors({ [err.field]: err.message });
      else setErrors({ form: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.stack} onSubmit={submit}>
      <div className={styles.ph}>
        {me.tracking === 'stopped' ? (
          <>
            <h1>Tracking stopped</h1>
            <p>
              Steam no longer accepts your code. Paste a new one to start again.
            </p>
          </>
        ) : (
          <>
            <h1>Track your matches</h1>
            <p>
              Every match you finish from now on is stored here with its replay.
              Steam needs two things from you, once.
            </p>
          </>
        )}
      </div>
      <div className={styles.step}>
        <span className="n">1</span>
        <p>
          Open{' '}
          <a href={SUPPORT} target="_blank" rel="noopener noreferrer">
            Steam Support: CS2, Access to Your Match History
          </a>
          . It opens in a new tab.
        </p>
      </div>
      <div className={styles.step}>
        <span className="n">2</span>
        <p>
          Press <b>Create Authentication Code</b>. Copy the code, then copy{' '}
          <b>Your most recently completed match token</b> from the same page.
        </p>
      </div>
      <Input
        id="authCode"
        label="Authentication code"
        placeholder="ABCD-EFGHI-JKLM"
        value={authCode}
        onChange={setAuthCode}
        error={errors.authCode}
        secret
      />
      <Input
        id="token"
        label="Most recently completed match token"
        placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
        value={token}
        onChange={setToken}
        error={errors.token}
      />
      <Input
        id="olderToken"
        label="An older match token (optional)"
        placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
        value={olderToken}
        onChange={setOlderToken}
        error={errors.olderToken}
        hint="From any match in the last 30 days (CS2's match list, Copy share link): we fetch everything since. Valve deletes replays after 30 days; for older matches, upload the demos CS2 downloaded, one at a time."
      />
      {errors.form && (
        <p className={styles.formErr} role="alert">
          {errors.form}
        </p>
      )}
      <button
        type="submit"
        className={styles.go}
        disabled={busy || !authCode || !token}
      >
        {busy ? 'Checking with Steam…' : 'Start tracking'}
      </button>
      <button type="button" className={styles.ghost} onClick={signOutHere}>
        Sign out
      </button>
    </form>
  );
}

function On({
  me,
  onOff,
  onSignedOut,
}: {
  me: Me;
  onOff: () => void;
  onSignedOut: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const act = (f: () => Promise<void>, then: () => void) => async () => {
    setError(null);
    try {
      await f();
      then();
    } catch (err) {
      setError(messageOf(err));
    }
  };
  return (
    <div className={styles.stack}>
      <div className={styles.ok}>
        <div className={styles.tick} aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="square"
          >
            <path d="M4 12l5 5L20 6" />
          </svg>
        </div>
        <div className={styles.txt}>
          <h1>Tracking on</h1>
          <p>
            The site checks for new matches every 15 minutes. A match you finish
            from now on shows up on your profile after the next check, each with
            its replay.
          </p>
        </div>
      </div>
      <p className={styles.note}>
        Your code and token are kept only to fetch your matches from Steam.
        Revoke the code on the same support page and tracking stops.
      </p>
      <SiteLink className={styles.go} href={`/profiles/${me.steamid}`}>
        Open my profile
      </SiteLink>
      <div className={styles.twin}>
        <button
          type="button"
          className={styles.ghost}
          onClick={act(stopTracking, onOff)}
        >
          Stop tracking
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={act(signOut, onSignedOut)}
        >
          Sign out
        </button>
      </div>
      {error && (
        <p className={styles.formErr} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default function TrackView() {
  // Every change goes to every reader of who is signed in (the bar too).
  const [me, update] = useMe();
  const assets = useSiteAssets();
  const failed =
    new URLSearchParams(window.location.search).get('signin') === 'failed';
  useEffect(() => {
    document.title = pageTitle('Track your matches');
  }, []);

  let body;
  if (me === undefined) body = <div className={styles.ph} aria-busy="true" />;
  else if (me === null)
    body = (
      <div className={styles.stack}>
        <div className={styles.ph}>
          <h1>Track your matches</h1>
          <p>
            {failed
              ? 'Signing in through Steam did not finish. Try again.'
              : 'Sign in through Steam to share your match history: every match you finish is stored here with its replay.'}
          </p>
        </div>
        {/* Steam's logo, as on the bar's own way in. */}
        <a className={styles.go} href="/auth/steam">
          {assets && (
            <img src={steamLogoUrl(assets)} alt="" width={22} height={22} />
          )}
          Sign in through Steam
        </a>
      </div>
    );
  else if (me.tracking === 'on')
    body = (
      <On
        me={me}
        onOff={() => update({ ...me, tracking: 'off' })}
        onSignedOut={() => update(null)}
      />
    );
  else
    body = (
      <Form
        me={me}
        onOn={() => update({ ...me, tracking: 'on' })}
        onSignedOut={() => update(null)}
      />
    );

  return (
    <div className="site">
      <SiteBar />
      <main className={styles.wrap}>
        <div className={styles.panel}>{body}</div>
      </main>
      <SiteFoot />
    </div>
  );
}
