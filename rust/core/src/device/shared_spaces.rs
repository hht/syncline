//! Device-side registration of shared spaces: claiming space names and tables (preventing duplicate table names across spaces),
//! initializing shared spaces, and providing access to the database and side effects.
//! What it should not know: how shared spaces ingest cloud changes.

use super::Device;
use crate::effects::Effects;
use crate::error::Error;
use crate::shared_space::SharedSpace;
use crate::tables::Table;
use std::collections::HashSet;

impl Device {
    /// Claims a shared space name and its tables, to be opened subsequently through the task queue (table creation and upgrades via `open_shared`):
    /// name must not be empty, must not already be open, and tables must not collide with existing synced tables, local-only tables, or tables in other shared spaces.
    ///
    /// # Errors
    ///
    /// Returns an error if the space name or table names violate registration rules.
    pub fn declare_shared(&mut self, name: &str, tables: Vec<Table>, owner: Option<String>) -> Result<(), Error> {
        if name.is_empty() {
            return Err(Error::Failed("shared space name must not be empty".to_owned()));
        }
        // Opening the same space twice causes concurrent writes to shared cursor and staging storage
        if self.shared.contains_key(name) {
            return Err(Error::Failed(format!("shared space {name} is already open")));
        }
        let mut taken: HashSet<&String> = self.synced.declaration().keys().chain(&self.local_only).collect();
        taken.extend(self.shared.values().flat_map(SharedSpace::tables));
        for table in &tables {
            if !taken.insert(&table.name) {
                return Err(Error::Failed(format!(
                    "table has the same name as an existing synced or local-only table: {}",
                    table.name
                )));
            }
        }
        self.shared.insert(name.to_owned(), SharedSpace::new(name, tables, owner));
        Ok(())
    }

    /// Opens a claimed shared space: creates tables, upgrades schema, and verifies owner identity (`owner` is the current authenticated user).
    ///
    /// # Errors
    ///
    /// Returns an error if the space was not claimed, or see [`SharedSpace::open`].
    pub fn open_shared(&mut self, name: &str) -> Result<(), Error> {
        let Device {
            shared,
            db,
            effects,
            retired,
            ..
        } = self;
        let space = shared
            .get_mut(name)
            .ok_or_else(|| Error::Failed(format!("shared space {name} does not exist")))?;
        space.open(db.connection(), effects, retired)
    }

    /// Returns a claimed shared space along with its database connection and side effects.
    ///
    /// # Errors
    ///
    /// Returns an error if the space was not claimed.
    pub fn shared(&mut self, name: &str) -> Result<(&mut SharedSpace, &rusqlite::Connection, &mut Effects), Error> {
        match self.shared.get_mut(name) {
            Some(space) => Ok((space, self.db.connection(), &mut self.effects)),
            None => Err(Error::Failed(format!("shared space {name} does not exist"))),
        }
    }
}
