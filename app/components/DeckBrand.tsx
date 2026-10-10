import { Link } from "react-router";
import { useAppName } from "~/lib/brand";

export default function DeckBrand() {
  const appName = useAppName();
  return (
    <Link to="/" className="deck-brand" aria-label={`${appName} — all inboxes`}>
      <img
        className="deck-brand-logo"
        src="/brand/logo.svg"
        alt={appName}
        width={1166}
        height={172}
      />
    </Link>
  );
}

export function DeckStatus({ children }: { children?: React.ReactNode }) {
  const appName = useAppName();
  return (
    <footer className="deck-status">
      <span>
        <i className="status-led" />
        {children || appName}
      </span>
    </footer>
  );
}
