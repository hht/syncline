//! 共用空间在设备上的登记：占下名字与表（不与已有的表重名），打开它，交出它与它用的库、副作用。
//! 不该知道的：共用空间怎么收云端的改动。

use super::Device;
use crate::effects::Effects;
use crate::error::Error;
use crate::shared_space::SharedSpace;
use crate::tables::Table;
use std::collections::HashSet;

impl Device {
    /// 占下一个共用空间的名字与它的表，之后由外层排进队列里打开（建表、升级，`open_shared`）：名字不能是空串、不能已开着，
    /// 表不能与私有空间的同步表、本机专用的表、别的共用空间的表重名
    ///
    /// # Errors
    /// 名字或表名不合上面的规则。
    pub fn declare_shared(&mut self, name: &str, tables: Vec<Table>) -> Result<(), Error> {
        if name.is_empty() {
            return Err(Error::Failed("共用空间要有名字".to_owned()));
        }
        // 同一个空间开两份：两份各自写同一份游标与暂存，两条连接互相打乱
        if self.shared.contains_key(name) {
            return Err(Error::Failed(format!("共用空间 {name} 已经开着")));
        }
        let mut taken: HashSet<&String> = self.synced.declaration().keys().chain(&self.local_only).collect();
        taken.extend(self.shared.values().flat_map(SharedSpace::tables));
        for table in &tables {
            if !taken.insert(&table.name) {
                return Err(Error::Failed(format!("同步表重名：{}", table.name)));
            }
        }
        self.shared.insert(name.to_owned(), SharedSpace::new(name, tables));
        Ok(())
    }

    /// 打开占下的共用空间：建表、升级、认人（owner 是这次登录的人）
    ///
    /// # Errors
    /// 没占下；见 `SharedSpace::open`。
    pub fn open_shared(&mut self, name: &str, owner: Option<&str>) -> Result<(), Error> {
        let Device {
            shared,
            db,
            effects,
            retired,
            ..
        } = self;
        let space = shared.get_mut(name).ok_or_else(|| Error::Failed(format!("没有共用空间 {name}")))?;
        space.open(db.connection(), effects, retired, owner)
    }

    /// 占下了的共用空间，连同它用的库与副作用
    ///
    /// # Errors
    /// 没有占下这个空间。
    pub fn shared(&mut self, name: &str) -> Result<(&mut SharedSpace, &rusqlite::Connection, &mut Effects), Error> {
        match self.shared.get_mut(name) {
            Some(space) => Ok((space, self.db.connection(), &mut self.effects)),
            None => Err(Error::Failed(format!("没有共用空间 {name}"))),
        }
    }
}
