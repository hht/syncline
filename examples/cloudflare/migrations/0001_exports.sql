-- Export destination: each space's exported notes, and how far each space has exported.
CREATE TABLE exported_note (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
CREATE TABLE export_position (space TEXT PRIMARY KEY, position TEXT NOT NULL);
