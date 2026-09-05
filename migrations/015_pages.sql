-- Pages: several tabbed dashboards per user (docs/pages-spec.md). The page
-- list lives beside the layout; a ward names its page with `page` on its
-- WardInstance (absent = the first page). '[]' reads as one implicit "Home"
-- page, so no existing row needs a rewrite.
ALTER TABLE dashboards ADD COLUMN pages_json TEXT NOT NULL DEFAULT '[]';
