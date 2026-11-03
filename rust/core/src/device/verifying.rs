//! 设备这一侧接上校验和：开始与推进一段核对，给出核对时设备这一刻的样子（数据的状态、各表的主键、游标）。
//! 不该知道的：什么时候对、怎么算、对不上怎么办。

use super::Device;
use crate::error::Error;
use crate::protocol::Cookie;
use crate::upload_queue::UploadQueue;
use crate::verifier::{Moment, Progress};
use std::collections::HashMap;

/// 对一段校验和时设备这一刻的样子（`Device::moment`）
type Snapshot = (Option<String>, HashMap<String, Vec<String>>, Option<Cookie>);

impl Device {
    /// 开始核对一段校验和；没装、不能对返回假（作罢）。live 是连接没停、本机库没关
    ///
    /// # Errors
    /// 读库出错。
    pub fn verify_begin(&mut self, live: bool) -> Result<bool, Error> {
        let (mark, keys, cookie) = self.moment(live)?;
        let db = self.db.connection();
        match &mut self.verifier {
            Some(verifier) if !verifier.running() => verifier.begin(
                db,
                &Moment {
                    live,
                    mark,
                    cookie,
                    keys: &keys,
                },
            ),
            _ => Ok(false),
        }
    }

    /// 核对一步；没在核对是作罢
    ///
    /// # Errors
    /// 读写库出错（外层报出、作罢）。
    pub fn verify_step(&mut self, live: bool, now: f64) -> Result<Progress, Error> {
        let (mark, keys, cookie) = self.moment(live)?;
        let db = self.db.connection();
        let Some(verifier) = &mut self.verifier else {
            return Ok(Progress::Done(None));
        };
        let moment = Moment {
            live,
            mark,
            cookie,
            keys: &keys,
        };
        let progress = verifier.step(db, &moment, &mut self.effects, now);
        if !matches!(progress, Ok(Progress::More)) {
            verifier.stop();
        }
        progress
    }

    /// 对一段时设备这一刻的样子：同步的数据的状态（没有待上传、没在分块拉取时是游标的 JSON）、各张同步表的主键、游标
    fn moment(&self, live: bool) -> Result<Snapshot, Error> {
        let db = self.db.connection();
        let cookie = self.cookie()?;
        let mark = if live && UploadQueue::is_empty(db)? && !self.staging()? {
            Some(serde_json::to_string(&cookie).map_err(|error| Error::Failed(error.to_string()))?)
        } else {
            None
        };
        let keys = self
            .synced
            .keys()
            .into_iter()
            .map(|(name, key)| (name.to_owned(), key.to_vec()))
            .collect();
        Ok((mark, keys, cookie))
    }
}
