-- Attachment text for search (docs/d1-migration-plan.md, Attachment text).
-- New mail queues its attachments when it is stored; this queues the ones
-- stored before, with the rule in workers/lib/attachment-kind.ts. The cron
-- converts queued files only when ATTACHMENT_SEARCH is "true".

-- The cron's queue: rows waiting or being converted.
CREATE INDEX attachment_text_queue ON attachment_text (state, updated_at) WHERE state IN ('pending', 'working');

INSERT OR IGNORE INTO attachment_text (attachment_id, state, updated_at)
SELECT id, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM attachments
WHERE COALESCE(disposition, 'attachment') != 'inline'
	AND size <= 10485760
	AND (
		lower(trim(CASE WHEN instr(mimetype, ';') > 0 THEN substr(mimetype, 1, instr(mimetype, ';') - 1) ELSE mimetype END)) IN (
			'application/pdf',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel.sheet.macroenabled.12',
			'application/vnd.ms-excel',
			'application/vnd.oasis.opendocument.text',
			'application/vnd.oasis.opendocument.spreadsheet',
			'text/plain',
			'text/csv',
			'text/markdown'
		)
		OR lower(filename) LIKE '%.pdf' OR lower(filename) LIKE '%.docx' OR lower(filename) LIKE '%.xlsx'
		OR lower(filename) LIKE '%.xlsm' OR lower(filename) LIKE '%.xls' OR lower(filename) LIKE '%.odt'
		OR lower(filename) LIKE '%.ods' OR lower(filename) LIKE '%.txt' OR lower(filename) LIKE '%.csv'
		OR lower(filename) LIKE '%.md'
	);
