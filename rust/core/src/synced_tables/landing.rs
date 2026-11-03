//! 分块拉取的改动怎么暂存、落地：块的改动先进暂存，整份与整张表重给的行写进影子表，末块到了换上影子表、与暂存的一起写进同步表；
//! 改动少的不暂存，一条条写。
//! 不该知道的：块从哪来、什么时候算末块。

use super::SyncedTables;
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::Op;
use crate::shadow_tables::{drop_shadow, same_shape, shadowed, stash, swap_shadow};
use crate::stage::Stage;
use crate::staged_write::write_table;
use rusqlite::Connection;

/// 改动多于这么多条时在 SQLite 里一次写，比一条条写快；通知通常只有几条
const MANY_OPS: usize = 500;

impl SyncedTables {
    /// 暂存一块的改动：整份与整张表重给的行写进影子表，其余进暂存
    ///
    /// # Errors
    /// 读写库出错。
    pub fn stash(&self, db: &Connection, patch: &[Op], stage: &Stage) -> Result<(), Error> {
        stash(db, &self.tables, patch, stage)
    }

    /// 末块落地：先换上影子表（这几张整张重给了，`_syncline_unknown` 里存着的它们的行一并丢掉；暂存记下的清空、删表删列不再对它们做，影子表上做过了），
    /// 再把 stage 暂存的改动一次写进同步表
    ///
    /// # Errors
    /// 读写库出错。
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
            // 一条条写的：这张表有之前放不进本机的列、存着的行（一条条写顺带清掉存着的那份），或有的行放不进本机的列（放不进的那几行先存着）
            if !self.unknown.has(db, name)? {
                match write_table(db, stage, table) {
                    Ok(written) => {
                        if written {
                            effects.touch(name);
                        }
                        continue;
                    }
                    Err(error) if error.is_constraint() => {}
                    Err(error) => return Err(error),
                }
            }
            for op in stage.ops(db, name)? {
                self.write(db, &op, effects)?;
            }
        }
        // 本机还没有的表：一条条存
        for table in staged.iter().filter(|table| !table.is_empty() && !self.tables.contains_key(*table)) {
            for op in stage.ops(db, table)? {
                self.write(db, &op, effects)?;
            }
        }
        Ok(())
    }

    /// 收下末块或通知的改动（在调用方开好的本机事务里），返回空没空出页（调用方之后收缩库文件）：有暂存的块（分块拉取的末块）或改动很多时也暂存，
    /// 换上影子表、与暂存的一起在 SQLite 里写进同步表，再清空暂存；改动少的一条条写
    ///
    /// # Errors
    /// 读写库出错。
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

    /// 丢掉影子表：与暂存一起丢（整份重拉、清空重下）
    ///
    /// # Errors
    /// 读写库出错。
    pub fn drop_shadows(&self, db: &Connection) -> rusqlite::Result<()> {
        for name in shadowed(db, &self.names)? {
            drop_shadow(db, &name)?;
        }
        Ok(())
    }

    /// 影子表都还与它的同步表一个样子：这次发布没给有影子表的同步表加列、删列、加索引
    ///
    /// # Errors
    /// 读库出错。
    pub fn shadows_fit(&self, db: &Connection) -> rusqlite::Result<bool> {
        for name in shadowed(db, &self.names)? {
            if !same_shape(db, &name)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
