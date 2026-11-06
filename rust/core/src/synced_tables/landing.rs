//! How chunked pull changes are staged and landed: chunk changes are staged first, rows from full resync or whole-table resets are written to shadow tables; upon final chunk arrival, shadow tables are swapped in and bulk written alongside staged changes into synced tables;
//! small changes skip staging and write row-by-row.
//! What it should not know: where chunks come from, when a chunk is considered final.

use super::SyncedTables;
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::Op;
use crate::shadow_tables::{drop_shadow, same_shape, shadowed, stash, swap_shadow};
use crate::stage::Stage;
use crate::staged_write::write_table;
use rusqlite::Connection;

/// Bulk write in SQLite when operations exceed this threshold, faster than writing one by one; notifications typically contain only a few operations.
const MANY_OPS: usize = 500;

impl SyncedTables {
    /// Stages changes from a chunk: rows from full resync or whole-table resets written to shadow tables, remainder into stage.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn stash(&self, db: &Connection, patch: &[Op], stage: &Stage) -> Result<(), Error> {
        stash(db, &self.tables, patch, stage)
    }

    /// Final chunk landing: swaps in shadow tables first (these tables were reset in full, so their retained rows in `_syncline_unknown` are discarded; staged clears, drops of tables/columns are skipped for them since shadow tables already did them),
    /// then bulk writes staged changes from stage into synced tables.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn land(&self, db: &Connection, stage: &Stage, effects: &mut Effects) -> Result<(), Error> {
        let replaced = shadowed(db, &self.names)?;
        for name in self.names.iter().filter(|name| replaced.contains(*name)) {
            swap_shadow(db, name)?;
            self.unknown.clear(db, Some(name), None)?;
            effects.touch(name);
        }
        let staged = stage.tables(db)?;
        for table in &staged {
            for op in stage.resets(db, table)? {
                match &op {
                    Op::Clear => self.clear(db, &replaced, effects)?,
                    Op::Drop { table, .. } if !replaced.contains(table) => self.write(db, &op, effects)?,
                    _ => {}
                }
            }
        }
        for name in &self.names {
            let table = &self.tables[name];
            // Writes row-by-row: this table has previously retained rows whose values did not fit local columns (row-by-row write clears the retained copy), or some rows do not fit local columns (incompatible rows are retained).
            if !self.unknown.has(db, name)? {
                match write_table(db, stage, table) {
                    Ok(written) => {
                        if written {
                            effects.touch(name);
                        }
                        continue;
                    }
                    Err(error) if error.is_constraint(db) => {}
                    Err(error) => return Err(error),
                }
            }
            for op in stage.ops(db, name)? {
                self.write(db, &op, effects)?;
            }
        }
        // Tables not yet present locally: store row-by-row.
        for table in staged.iter().filter(|table| !table.is_empty() && !self.tables.contains_key(*table)) {
            for op in stage.ops(db, table)? {
                self.write(db, &op, effects)?;
            }
        }
        Ok(())
    }

    /// Receives changes from a final chunk or notification (within a local transaction opened by caller); returns whether pages were freed (caller can vacuum/shrink database afterwards): stages when staged chunks exist (final chunk of chunked pull) or operations are numerous,
    /// swaps in shadow tables, bulk writes into synced tables in SQLite alongside staged operations, then clears stage; small changes write row-by-row.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn write_patch(&self, db: &Connection, patch: &[Op], stage: &Stage, staged: bool, effects: &mut Effects) -> Result<bool, Error> {
        if !staged && patch.len() < MANY_OPS {
            for op in patch {
                self.write(db, op, effects)?;
            }
            return Ok(false);
        }
        self.stash(db, patch, stage)?;
        self.land(db, stage, effects)?;
        stage.clear(db)?;
        Ok(true)
    }

    /// Drops shadow tables: discarded alongside stage (full resync, clear and redownload).
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn drop_shadows(&self, db: &Connection) -> rusqlite::Result<()> {
        for name in shadowed(db, &self.names)? {
            drop_shadow(db, &name)?;
        }
        Ok(())
    }

    /// Shadow tables still match their synced tables in shape: current release did not add columns, drop columns, or add indexes to synced tables with shadow tables.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn shadows_fit(&self, db: &Connection) -> rusqlite::Result<bool> {
        for name in shadowed(db, &self.names)? {
            if !same_shape(db, &name)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
