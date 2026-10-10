import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  EnvelopeSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TrayIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { formatListDate } from "shared/dates";
import DeckBrand, { DeckStatus } from "~/components/DeckBrand";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import MailboxDirectory from "~/components/MailboxDirectory";
import { getSnippetText } from "~/lib/utils";
import { useEmail } from "~/queries/emails";
import { useMailboxes } from "~/queries/mailboxes";
import type { Email } from "~/types";
import api from "~/services/api";

type Message = Email & { mailboxId: string };
type SelectedMessage = { mailboxId: string; id: string };
const isUnread = (email: Email) =>
  email.thread_unread_count !== undefined
    ? email.thread_unread_count > 0
    : !email.read;

function MessagePreview({
  message,
  onClose,
  previous,
  next,
  position,
}: {
  message: SelectedMessage;
  onClose: () => void;
  previous?: () => void;
  next?: () => void;
  position: string;
}) {
  const {
    data: email,
    isPending,
    error,
    refetch,
  } = useEmail(message.mailboxId, message.id);
  const mailboxUrl = `/mailbox/${encodeURIComponent(message.mailboxId)}/emails/inbox?email=${encodeURIComponent(message.id)}`;
  return (
    <article className="message-reader" aria-label="Selected conversation">
      <div className="reader-controls">
        <button
          type="button"
          className="deck-button icon-button"
          onClick={onClose}
          aria-label="Back to messages"
        >
          <ArrowLeftIcon size={17} />
        </button>
        <span className="reader-mode">Message</span>
        <div className="transport-controls">
          <span className="track-position">{position}</span>
          <button
            type="button"
            className="deck-button icon-button"
            onClick={previous}
            disabled={!previous}
            aria-label="Previous message"
          >
            <CaretLeftIcon size={16} weight="fill" />
          </button>
          <button
            type="button"
            className="deck-button icon-button"
            onClick={next}
            disabled={!next}
            aria-label="Next message"
          >
            <CaretRightIcon size={16} weight="fill" />
          </button>
        </div>
        <RouterLink to={mailboxUrl} className="deck-button open-conversation">
          Open conversation <ArrowSquareOutIcon size={14} />
        </RouterLink>
      </div>
      {isPending ? (
        <p className="deck-empty" role="status">
          Loading message…
        </p>
      ) : error ? (
        <div className="deck-empty" role="alert">
          Could not load this message.
          <button className="deck-button" onClick={() => refetch()}>
            Try again
          </button>
        </div>
      ) : email ? (
        <>
          <div className="reader-subject">
            <span className="mailbox-label">{message.mailboxId}</span>
            <h2>{email.subject || "(no subject)"}</h2>
          </div>
          <div className="reader-content">
            <SingleMessageView
              email={email}
              mailboxId={message.mailboxId}
              onPreviewImage={(url) =>
                window.open(url, "_blank", "noopener,noreferrer")
              }
            />
          </div>
        </>
      ) : null}
    </article>
  );
}

export default function CombinedInbox({ controls }: { controls: ReactNode }) {
  const [selected, setSelected] = useState<SelectedMessage | null>(null);
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [readError, setReadError] = useState(false);
  const { data: mailboxes = [] } = useMailboxes();
  const navigate = useNavigate();
  const {
    data,
    error,
    isPending,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["combined-inbox"],
    queryFn: ({ pageParam, signal }) =>
      api.getCombinedInbox(pageParam, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const emails = data?.pages.flatMap((page) => page.emails) ?? [];
  const totalCount = data?.pages[0]?.totalCount ?? 0;
  const visible = emails.filter(
    (email) =>
      (!unreadOnly ||
        isUnread(email) ||
        (selected?.id === email.id &&
          selected.mailboxId === email.mailboxId)) &&
      `${email.sender} ${email.subject} ${getSnippetText(email.snippet)} ${email.mailboxId}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  const selectedIndex = visible.findIndex(
    (email) =>
      email.id === selected?.id && email.mailboxId === selected.mailboxId,
  );
  const selectMessage = (email: Message) => {
    setSelected({ mailboxId: email.mailboxId, id: email.id });
    setReadError(false);
    if (isUnread(email)) {
      const markRead = email.thread_id
        ? api.markThreadRead(email.mailboxId, email.thread_id)
        : api.updateEmail(email.mailboxId, email.id, { read: true });
      markRead.then(() => refetch()).catch(() => setReadError(true));
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const composeMailbox = selected?.mailboxId || mailboxes[0]?.id;

  return (
    <section className="mail-deck" aria-labelledby="combined-inbox-title">
      <header className="deck-topbar">
        <DeckBrand />
        <div className="lcd-panel">
          <div>
            <h1 id="combined-inbox-title">All inboxes</h1>
          </div>
          <div className="lcd-count">
            <strong>{totalCount.toLocaleString()}</strong>
            <span>conversations</span>
          </div>
        </div>
        <div className="home-mailbox-controls">{controls}</div>
      </header>
      <div className="deck-workspace">
        <aside className="deck-sidebar" aria-label="Mailboxes">
          <button
            type="button"
            className="compose-record"
            disabled={!composeMailbox}
            title={
              composeMailbox
                ? `Compose from ${composeMailbox}`
                : "Choose a mailbox first"
            }
            onClick={() =>
              navigate(
                `/mailbox/${encodeURIComponent(composeMailbox!)}/emails/inbox?compose=new`,
              )
            }
          >
            <PencilSimpleIcon size={18} weight="bold" />
            Compose
          </button>
          <RouterLink to="/" className="deck-folder active" aria-current="page">
            <TrayIcon size={18} />
            <span>All inboxes</span>
            <b>{totalCount}</b>
          </RouterLink>
          <MailboxDirectory variant="sidebar" skipTo="combined-message-list" />
        </aside>
        <main className="deck-main">
          <div className="deck-inbox-tools">
            <button
              type="button"
              className="deck-button mobile-compose"
              aria-label="Compose email"
              disabled={!composeMailbox}
              onClick={() =>
                navigate(
                  `/mailbox/${encodeURIComponent(composeMailbox!)}/emails/inbox?compose=new`,
                )
              }
            >
              <PencilSimpleIcon size={17} />
            </button>
            <div className="filter-switch" aria-label="Filter messages">
              <button
                type="button"
                aria-pressed={!unreadOnly}
                onClick={() => setUnreadOnly(false)}
              >
                All mail
              </button>
              <button
                type="button"
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly(true)}
              >
                Unread
              </button>
            </div>
            <button
              type="button"
              className="deck-button icon-button"
              aria-label="Refresh messages"
              disabled={isFetching}
              onClick={() => refetch()}
            >
              <ArrowsClockwiseIcon
                size={17}
                className={isFetching ? "animate-spin" : ""}
              />
            </button>
            <div className="deck-search">
              <MagnifyingGlassIcon size={17} />
              <input
                aria-label="Filter loaded messages"
                placeholder="Find in loaded mail…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button type="button" aria-label="Clear filter" onClick={() => setQuery("")}>
                  <XIcon size={16} />
                </button>
              )}
            </div>
          </div>
          {readError && (
            <p role="alert" className="read-error">
              Message opened, but could not be marked read. Refresh and try
              again.
            </p>
          )}
          <div className={`deck-inbox ${selected ? "has-selection" : ""}`}>
            <div
              id="combined-message-list"
              tabIndex={-1}
              role="region"
              className="deck-message-list mail-list-scroll"
              aria-label="Messages"
            >
              <div className="list-caption">
                <span>Sender / subject</span>
                <span>Newest first</span>
              </div>
              {isPending ? (
                <p className="deck-empty" role="status">
                  Loading messages…
                </p>
              ) : error ? (
                <div className="deck-empty" role="alert">
                  Could not load inbox.
                  <button className="deck-button" onClick={() => refetch()}>
                    Try again
                  </button>
                </div>
              ) : visible.length === 0 ? (
                <div className="deck-empty">
                  <EnvelopeSimpleIcon size={30} />
                  <strong>
                    {query || unreadOnly
                      ? "No matching messages"
                      : "You're all caught up"}
                  </strong>
                  <span>
                    {query || unreadOnly
                      ? "Try another filter or load more messages."
                      : "New mail will appear here."}
                  </span>
                </div>
              ) : (
                visible.map((email) => {
                  const active =
                    selected?.mailboxId === email.mailboxId &&
                    selected.id === email.id;
                  return (
                    <button
                      key={`${email.mailboxId}/${email.id}`}
                      type="button"
                      className={`message-row ${isUnread(email) ? "is-unread" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => selectMessage(email)}
                    >
                      <span className="message-row-top">
                        <span className="message-sender">
                          <i className="unread-dot" />
                          {email.sender}
                        </span>
                        <time dateTime={email.date}>
                          {formatListDate(email.date)}
                        </time>
                      </span>
                      <strong className="message-subject">
                        {email.subject || "(no subject)"}
                      </strong>
                      <span className="message-snippet">
                        {getSnippetText(email.snippet)}
                      </span>
                      <span className="message-account">
                        {email.mailboxId}
                        {(email.thread_count ?? 1) > 1 && (
                          <b>{email.thread_count} messages</b>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
              {hasNextPage && (
                <div className="load-more">
                  <button
                    className="deck-button"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                  >
                    {isFetchingNextPage ? "Loading…" : "Load more messages"}
                  </button>
                </div>
              )}
            </div>
            {selected ? (
              <MessagePreview
                key={`${selected.mailboxId}/${selected.id}`}
                message={selected}
                onClose={() => setSelected(null)}
                position={
                  selectedIndex >= 0
                    ? `${selectedIndex + 1} / ${visible.length}`
                    : "–"
                }
                previous={
                  selectedIndex > 0
                    ? () => selectMessage(visible[selectedIndex - 1])
                    : undefined
                }
                next={
                  selectedIndex >= 0 && selectedIndex < visible.length - 1
                    ? () => selectMessage(visible[selectedIndex + 1])
                    : undefined
                }
              />
            ) : (
              <div className="reader-idle">
                <img className="idle-stamp" src="/brand/app-icon.svg" alt="" width={104} height={104} />
                <h2>A little mail. A lot of possibility.</h2>
                <p>Pick a conversation. Make yourself at home.</p>
              </div>
            )}
          </div>
        </main>
      </div>
      <DeckStatus>
        {isFetching
          ? "Receiving messages…"
          : `${emails.length} of ${totalCount} conversations loaded`}
      </DeckStatus>
    </section>
  );
}
