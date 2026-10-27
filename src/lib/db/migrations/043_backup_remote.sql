-- Remote archive identity is stored separately from the optional local cache.
ALTER TABLE backup_records ADD COLUMN remote_json TEXT;
ALTER TABLE backup_records ADD COLUMN upload_status TEXT;
ALTER TABLE backup_records ADD COLUMN uploaded_at TEXT;
ALTER TABLE backup_records ADD COLUMN upload_error TEXT;
ALTER TABLE backup_records ADD COLUMN local_expires_at TEXT;
