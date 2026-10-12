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
        width={1324}
        height={137}
      />
    </Link>
  );
}
