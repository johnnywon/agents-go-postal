-- Mail storage on D1 (docs/d1-migration-plan.md). Append-only once a
-- deployment has applied it: change the schema with a new numbered file.
--
-- `messages` uses the combined index's column names (state, thread_key,
-- sender_addr, recipients, unread, deleted), so the list, facet and bulk
-- queries in workers/lib/mail-index-sql.ts and mail-bulk-sql.ts run on it
-- unchanged. Labels, undo and bulk jobs mirror the index's tables.

CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,                 -- the address, lowercase
	settings TEXT NOT NULL DEFAULT '{}', -- JSON: display name, signature, agent prompt
	folders_imported INTEGER NOT NULL DEFAULT 0, -- custom folders became labels; moves go to system folders only
	created_at TEXT NOT NULL
);

CREATE TABLE folders (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	is_deletable INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (mailbox_id, id),
	UNIQUE (mailbox_id, name)
);

CREATE TABLE messages (
	id INTEGER PRIMARY KEY,              -- the search indexes' rowid
	email_id TEXT NOT NULL UNIQUE,       -- the message's id in URLs and R2 keys
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	folder_id TEXT NOT NULL,
	state TEXT GENERATED ALWAYS AS (
		CASE WHEN folder_id IN ('inbox', 'sent', 'draft', 'archive', 'spam', 'trash') THEN folder_id ELSE 'folder:' || folder_id END
	) STORED,
	thread_id TEXT,                      -- RFC threading as received
	conversation_id TEXT NOT NULL,       -- how the list groups it: thread, reply draft or subject
	thread_key TEXT GENERATED ALWAYS AS (mailbox_id || char(31) || conversation_id) STORED,
	message_id TEXT,                     -- RFC Message-ID
	in_reply_to TEXT,
	email_references TEXT,               -- JSON array
	date TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT '',
	subject_norm TEXT NOT NULL DEFAULT '',
	sender_addr TEXT NOT NULL DEFAULT '',
	sender_name TEXT NOT NULL DEFAULT '',
	sender_domain TEXT NOT NULL DEFAULT '',
	recipient TEXT NOT NULL DEFAULT '',
	cc TEXT,
	bcc TEXT,
	recipients TEXT NOT NULL DEFAULT '', -- recipient, cc and bcc, lowercase, for search and display
	snippet TEXT NOT NULL DEFAULT '',
	body TEXT,                           -- NULL when body_key is set
	body_key TEXT,                       -- R2 key for bodies over 512 KB
	raw_headers TEXT,
	size INTEGER NOT NULL DEFAULT 0,     -- bytes, body plus attachments
	read INTEGER NOT NULL DEFAULT 0,
	unread INTEGER GENERATED ALWAYS AS (CASE WHEN read = 0 THEN 1 ELSE 0 END) VIRTUAL,
	starred INTEGER NOT NULL DEFAULT 0,
	has_attachment INTEGER NOT NULL DEFAULT 0,
	list_id TEXT,
	unsubscribe TEXT,
	deleted INTEGER GENERATED ALWAYS AS (0) VIRTUAL, -- the index's tombstone flag; D1 deletes rows
	FOREIGN KEY (mailbox_id, folder_id) REFERENCES folders(mailbox_id, id)
);
CREATE INDEX messages_state_date ON messages (state, date DESC);
CREATE INDEX messages_folder_date ON messages (mailbox_id, folder_id, date DESC);
CREATE INDEX messages_thread ON messages (thread_key);
CREATE INDEX messages_mailbox_thread ON messages (mailbox_id, thread_id);
CREATE INDEX messages_message_id ON messages (message_id);
CREATE INDEX messages_in_reply_to ON messages (in_reply_to);
CREATE INDEX messages_sender_addr ON messages (sender_addr);
CREATE INDEX messages_sender_domain ON messages (sender_domain);
CREATE INDEX messages_mailbox ON messages (mailbox_id);

-- Word search, same columns as the index plus attachment names. Contentless
-- (3.9 KB per message in phase 0); snippets are built in the Worker. The
-- Worker writes rows with the message, since body_text comes from the HTML
-- body. rowid = messages.id.
CREATE VIRTUAL TABLE messages_fts USING fts5(
	subject, sender_name, sender_addr, recipients, body_text, attachment_names,
	content='', contentless_delete=1,
	tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);
INSERT INTO messages_fts (messages_fts, rank) VALUES ('rank', 'bm25(6.0, 3.0, 3.0, 2.0, 1.0, 2.0)');

-- Substring search over short fields, for codes and partial addresses.
CREATE VIRTUAL TABLE messages_trigram USING fts5(
	subject, sender_addr, recipients, attachment_names,
	content='', contentless_delete=1,
	tokenize='trigram'
);

-- Terms and document counts, for "Did you mean" and completion.
CREATE VIRTUAL TABLE messages_vocab USING fts5vocab(messages_fts, 'row');

-- Search rows leave with their message, including when a mailbox delete
-- cascades to its messages.
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
	DELETE FROM messages_fts WHERE rowid = old.id;
	DELETE FROM messages_trigram WHERE rowid = old.id;
END;

CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	email_id TEXT NOT NULL REFERENCES messages(email_id) ON DELETE CASCADE,
	filename TEXT NOT NULL,
	mimetype TEXT NOT NULL,
	size INTEGER NOT NULL,
	content_id TEXT,
	disposition TEXT
);
CREATE INDEX attachments_email ON attachments (email_id);

CREATE TABLE attachment_text (
	attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
	state TEXT NOT NULL,                 -- pending | done | skipped | failed
	text TEXT,                           -- capped at 64 KB
	updated_at TEXT NOT NULL
);

-- Labels, as in the index.
CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	color TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message_labels (
	message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
	PRIMARY KEY (message, label_id)
);
CREATE INDEX message_labels_label ON message_labels (label_id);
CREATE TABLE label_auto (
	label_id TEXT PRIMARY KEY REFERENCES labels(id) ON DELETE CASCADE,
	applied_at TEXT NOT NULL
);

CREATE TABLE saved_searches (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	filter TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scheduled_sends (
	email_id TEXT PRIMARY KEY REFERENCES messages(email_id) ON DELETE CASCADE, -- the draft
	mailbox_id TEXT NOT NULL,
	send_at TEXT NOT NULL,
	payload TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	claimed_at TEXT                      -- set by the cron run sending it
);
CREATE INDEX scheduled_sends_due ON scheduled_sends (send_at) WHERE attempts < 3;

CREATE TABLE send_keys (
	mailbox_id TEXT NOT NULL,
	key TEXT NOT NULL,
	state TEXT NOT NULL,                 -- pending | sent
	email_id TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, key)
);
CREATE INDEX send_keys_created ON send_keys (created_at);

-- Undo and bulk jobs, as in the index.
CREATE TABLE undo (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	payload TEXT NOT NULL
);
CREATE TABLE bulk_job (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	action TEXT NOT NULL,
	ops TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	total INTEGER NOT NULL,
	affected INTEGER NOT NULL DEFAULT 0,
	failed TEXT NOT NULL DEFAULT '[]',
	undo_id TEXT NOT NULL,
	finished_at TEXT
);
