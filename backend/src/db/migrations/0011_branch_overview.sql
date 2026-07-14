-- One agent-maintained Markdown paragraph per branch for the Branches document.

ALTER TABLE nodes ADD COLUMN branch_overview TEXT;
