-- has:link. NULL until the message is checked: new mail is checked when it
-- is stored, and the cron checks older mail a batch at a time.
ALTER TABLE messages ADD COLUMN has_link INTEGER;
CREATE INDEX messages_link_unchecked ON messages (id) WHERE has_link IS NULL;
