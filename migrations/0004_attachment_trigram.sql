-- Substring search over attachment text, for codes and numbers inside files.
-- One row per message holding all its converted attachment text; rowid =
-- messages.id. A separate table because an FTS5 table can't gain a column.
-- The cron writes it with the word index (workers/store/d1/attachment-text.ts).
CREATE VIRTUAL TABLE attachment_trigram USING fts5(
	text,
	content='', contentless_delete=1,
	tokenize='trigram'
);

CREATE TRIGGER messages_attachment_trigram_delete AFTER DELETE ON messages BEGIN
	DELETE FROM attachment_trigram WHERE rowid = old.id;
END;

-- Text converted before this migration.
INSERT INTO attachment_trigram (rowid, text)
SELECT m.id, group_concat(t.text, char(10) || char(10))
FROM messages m
JOIN attachments a ON a.email_id = m.email_id
JOIN attachment_text t ON t.attachment_id = a.id
WHERE t.state = 'done' AND t.text != ''
GROUP BY m.id;
