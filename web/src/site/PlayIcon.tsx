// The triangle on every button that opens a replay. Beside its word, so hidden from screen
// readers; its colour and size follow the word's (`.play` in tokens.css).

export default function PlayIcon() {
  return (
    <svg
      className="play"
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M2 1l9 5-9 5z" />
    </svg>
  );
}
