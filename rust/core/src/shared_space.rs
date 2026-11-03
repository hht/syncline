//! 设备上的一个共用空间（照 model/Shared.tla）：只读，云端下发的改动直接写进它的表，
//! 没有待上传、不用撤回重放；与私有空间在同一个库里，外层排在同一个队列里，界面照常联表查询。
//! 拉取的块可能是缓存里过时的副本：块先暂存，末块的版本不早于暂存各块的 seen 才一起生效；早于就当中间块暂存、接着从它的 next 拉，
//! 带上 atLeast（新的缓存键，不会再拿到过时的）。请求带游标、落地时按的订阅（末块给的，原样带回）与分块中途的位置：
//! 落在同一版、订阅相同的设备网址相同，共用一份缓存。订阅随令牌变：云端按新的订阅从游标与落地的订阅重起计划，
//! 回复按的订阅与暂存的块的不同就丢掉暂存；连接上的消息带着这条连接的订阅，与落地的不同就去拉。
//! 连接上的通知在没在拉、没有暂存、base 正好是本机游标、订阅与落地的相同时才应用；不比本机游标新的跳过；
//! 其余（拉取在路上、接不上、分片的提示）只记下目标位置（版本与空间的这一代，只在内存里），连接据此连着去拉；
//! 新起的请求带目标作下限（版本与代：新的缓存键，不拿缓存里更旧的或上一代的块），照 model/Shared.tla 的 Outgoing。
//! 代是空间建时定的随机数（清空重建后不同，版本号从头记）：只比相等，不比先后，另一代的位置一律算新；
//! 带着目标作下限的请求回来的不是那一代，就放下目标（分片说的是过时的一代）。
//! 拉取落地的订阅与连接上听到的不同：令牌换了、连接还是旧令牌连的，拉完换一条连接（stale，model/Shared.tla 的 Reconnect）。
//! 不该知道的：块从哪来、怎么缓存；私有空间的待上传与撤回重放。
//! @see <https://electric.ax/docs/api/http>（Live mode 的 handle、Control messages 的 must-refetch）

use crate::effects::Effects;
use crate::error::Error;
use crate::evolution::redeclare;
use crate::owner;
use crate::protocol::{Cookie, Op, Point};
use crate::savepoint;
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::tables::{self, Table};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

mod pulling;
mod receiving;

use pulling::Floor;

/// 落地时按的订阅：指纹与编好的订阅（拉取原样带回）
struct Subscription {
    sub: Option<String>,
    landed: Option<String>,
}

/// 收库与副作用的：在一个本机事务里做的都经它
type Host<'a> = (&'a Connection, &'a mut Effects);

fn parts<'b>(host: &'b mut Host<'_>) -> (&'b Connection, &'b mut Effects) {
    (host.0, &mut *host.1)
}

pub struct SharedSpace {
    name: String,
    /// 声明的表（打开时照它建表）
    tables: Vec<Table>,
    /// 打开好了（opened）才有：建表之后才读得出库里的列
    synced: Option<SyncedTables>,
    stage: Stage,
    /// 要追到的位置（model/Shared.tla 的 dWant，只在内存里；换连接不作废：分片说的那一版还要追到）
    wanted: Option<Point>,
    /// 在路上的拉取请求带的下限
    asked: Option<Floor>,
    /// 暂存的块是空间的哪一代（只在内存里）：过时的末块之后再拉，目标是另一代时下限取目标
    staged_incarnation: Option<i64>,
    /// 连接上听到的订阅的指纹（只在内存里，model/Shared.tla 的 dHeard）：与落地的不同（令牌换了）就要拉；开新连接时作废
    heard: Option<String>,
    /// 拉取落地的订阅与这条连接上听到的不同：连接是旧令牌连的，要换一条
    stale: bool,
}

impl SharedSpace {
    /// name：空间的名字，本机库里按它分开存游标与暂存的块；tables 是它的同步表。打开（`open`）之前就能读游标、拼拉取请求，收下要等打开好
    #[must_use]
    pub fn new(name: &str, tables: Vec<Table>) -> Self {
        SharedSpace {
            name: name.to_owned(),
            tables,
            synced: None,
            stage: Stage::new(name),
            wanted: None,
            asked: None,
            staged_incarnation: None,
            heard: None,
            stale: false,
        }
    }

    /// 打开：照声明建表、补列，升级本机表（再声明的表整份重拉），认人（换了人先清掉上一个人看过的行，库文件里也不留：
    /// 订阅变了要等整份重下落地才换掉，这之前不留给看不到它们的人），拉到一半的不合用就作废
    ///
    /// # Errors
    /// 表与库里已有的合不上；读写库出错。
    pub fn open(&mut self, db: &Connection, effects: &mut Effects, retired: &HashSet<String>, owner: Option<&str>) -> Result<(), Error> {
        tables::define(db, &self.tables)?;
        let synced = SyncedTables::new(db, &self.tables, &self.name, retired)?;
        let names: Vec<String> = synced.declaration().keys().cloned().collect();
        self.synced = Some(synced);
        let host = &mut (db, effects);
        savepoint::commit(host, parts, |host| {
            // 整份重拉：没有待上传，游标与暂存的块清掉、从头拉（第一块先清空）
            if redeclare(host.0, &self.name, &names)? {
                self.clear_cookie(host.0)?;
                self.unstage(host.0)?;
            }
            self.synced()?.upgrade(host.0, host.1)
        })?;
        if let Some(owner) = owner {
            let stored = owner::stored(db, &self.name)?;
            if stored.as_deref() != Some(owner) {
                if stored.is_some() {
                    owner::securely(host, |host| host.0, |host| self.reset(host))?;
                }
                owner::record(db, &self.name, owner)?;
            }
        }
        savepoint::commit(host, parts, |host| {
            // 影子表只在分块拉取途中有、与它的同步表一个样子：这次发布改了有影子表的同步表，或拉到一半时退回过更早的发布，拉到一半的作废、从头拉
            if !self.staging(host.0)? || !self.synced()?.shadows_fit(host.0)? {
                self.unstage(host.0)?;
            }
            Ok(())
        })
    }

    /// 同步表的名字
    pub fn tables(&self) -> impl Iterator<Item = &String> {
        self.tables.iter().map(|table| &table.name)
    }

    /// 打开好了的同步表
    fn synced(&self) -> Result<&SyncedTables, Error> {
        self.synced.as_ref().ok_or_else(|| Error::Failed("共用空间还没打开好".to_owned()))
    }

    /// 本机游标：还没同步过是 None
    ///
    /// # Errors
    /// 读库出错。
    pub fn cookie(&self, db: &Connection) -> rusqlite::Result<Option<Cookie>> {
        crate::internal::cookie(db, &self.name)
    }

    /// 分块拉取到一半（有暂存的块）：还要接着 HTTP 拉
    ///
    /// # Errors
    /// 读库出错。
    pub fn staging(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(self.stage.last(db)?.is_some())
    }

    /// 整份重下：丢掉这个空间的表、游标与暂存的块，之后整份拉（只读，没有待上传要留）
    ///
    /// # Errors
    /// 读写库出错。
    pub fn resync(&mut self, db: &Connection, effects: &mut Effects) -> Result<(), Error> {
        self.reset(&mut (db, effects))
    }

    /// 本机游标与本机数据是哪一代
    fn local(&self, db: &Connection) -> rusqlite::Result<Option<Point>> {
        let Some(cookie) = self.cookie(db)? else { return Ok(None) };
        let incarnation = db
            .prepare_cached("SELECT incarnation FROM _syncline_cookie WHERE space = ?")?
            .query_row([&self.name], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(Some(Point { cookie, incarnation }))
    }

    /// 落地时按的订阅；还没同步过的没有
    fn subscription(&self, db: &Connection) -> rusqlite::Result<Subscription> {
        Ok(db
            .prepare_cached("SELECT sub, landed FROM _syncline_cookie WHERE space = ?")?
            .query_row([&self.name], |row| {
                Ok(Subscription {
                    sub: row.get(0)?,
                    landed: row.get(1)?,
                })
            })
            .optional()?
            .unwrap_or(Subscription { sub: None, landed: None }))
    }

    fn clear_cookie(&self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_cookie WHERE space = ?", [&self.name])?;
        Ok(())
    }

    /// 丢掉暂存的块与影子表
    fn unstage(&self, db: &Connection) -> Result<(), Error> {
        self.synced()?.drop_shadows(db)?;
        self.stage.clear(db)?;
        Ok(())
    }

    /// 清空重下（用户要的、换了人登录）：目标一并放下
    fn reset(&mut self, host: &mut Host<'_>) -> Result<(), Error> {
        self.wanted = None;
        self.clear(host)
    }

    /// 丢掉这个空间的表、游标与暂存的块，之后整份拉（目标留着：云端认不出位置时，分片说的新一代还要追到）
    fn clear(&self, host: &mut Host<'_>) -> Result<(), Error> {
        savepoint::commit(host, parts, |host| {
            self.synced()?.write(host.0, &Op::Clear, host.1)?;
            self.clear_cookie(host.0)?;
            self.unstage(host.0)
        })
    }
}
