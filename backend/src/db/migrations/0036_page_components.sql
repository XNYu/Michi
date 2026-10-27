CREATE TABLE page_component_libraries (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at INTEGER NOT NULL
);

CREATE TABLE page_components (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  active_version INTEGER NOT NULL CHECK(active_version >= 1),
  latest_version INTEGER NOT NULL CHECK(latest_version >= 1),
  library_revision INTEGER NOT NULL CHECK(library_revision >= 1),
  revocation_epoch INTEGER NOT NULL DEFAULT 1 CHECK(revocation_epoch >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(id,workspace_id)
);
CREATE INDEX idx_page_components_workspace ON page_components(owner_user_id,workspace_id,deleted_at,name);
CREATE UNIQUE INDEX idx_page_components_live_name ON page_components(owner_user_id,workspace_id,name) WHERE deleted_at IS NULL;

CREATE TABLE page_component_versions (
  component_id TEXT NOT NULL REFERENCES page_components(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version >= 1),
  code TEXT NOT NULL,
  props_schema TEXT CHECK(props_schema IS NULL OR json_valid(props_schema)),
  source TEXT NOT NULL CHECK(json_valid(source)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(component_id,version)
);

/* Forward index for the later block/view adapters. A human-protected host stores
   a pinned version; an agent-owned host may follow active_version (NULL pin). */
CREATE TABLE page_component_refs (
  ref_id INTEGER PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  host_kind TEXT NOT NULL CHECK(host_kind IN ('page_block','database_view')),
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT,
  database_id TEXT REFERENCES page_databases(id) ON DELETE CASCADE,
  view_id TEXT,
  pinned_version INTEGER,
  protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  host_revision INTEGER NOT NULL CHECK(host_revision >= 1),
  updated_at INTEGER NOT NULL,
  CHECK((host_kind='page_block' AND page_id IS NOT NULL AND block_id IS NOT NULL AND database_id IS NULL AND view_id IS NULL)
    OR (host_kind='database_view' AND page_id IS NULL AND block_id IS NULL AND database_id IS NOT NULL AND view_id IS NOT NULL)),
  CHECK(protected=0 OR pinned_version IS NOT NULL),
  FOREIGN KEY(component_id,workspace_id) REFERENCES page_components(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(component_id,pinned_version) REFERENCES page_component_versions(component_id,version) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_page_component_ref_block ON page_component_refs(owner_user_id,workspace_id,page_id,block_id) WHERE host_kind='page_block';
CREATE UNIQUE INDEX idx_page_component_ref_view ON page_component_refs(owner_user_id,workspace_id,database_id,view_id) WHERE host_kind='database_view';
CREATE INDEX idx_page_component_refs_component ON page_component_refs(owner_user_id,workspace_id,component_id);
CREATE INDEX idx_page_component_refs_page ON page_component_refs(page_id,block_id);
CREATE INDEX idx_page_component_refs_database ON page_component_refs(database_id,view_id);
