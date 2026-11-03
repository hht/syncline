//! 收到云端改动时的 rebase：在一个本机事务里逆序撤回全部待上传、做这次的改动、删掉已确认的、重放剩下的；撤回失败就报出、整份重拉。
//! 不该知道的：改动从哪来、怎么写进同步表。

use super::Device;
use crate::change::Change;
use crate::changeset;
use crate::database::Database;
use crate::declaration::{Declaration, without_retired};
use crate::effects::Effects;
use crate::error::Error;
use crate::recorder::Recorder;
use crate::upload_queue::{Mutation, UploadQueue};
use std::collections::HashSet;

impl Device {
    /// 在一个本机事务里撤回全部待上传（revert 为假时不撤回）、做 change、删掉 lmids 确认了的、重放剩下的，返回确认了的。
    /// 撤回失败每次都会再出：报出、整条回滚，在另一个事务里做 fallback（整份重拉），返回 None
    pub(super) fn onto(
        &mut self,
        change: impl FnOnce(&mut Self) -> Result<(), Error>,
        lmids: &crate::protocol::Lmids,
        revert: bool,
        fallback: impl FnOnce(&mut Self) -> Result<(), Error>,
    ) -> Result<Option<Vec<Mutation>>, Error> {
        let mut confirmed = Vec::new();
        let mut revert_failed = None;
        let result = self.commit(|device| {
            // 待上传读一次：撤回与重放都用它（change 不改待上传）
            let pending = UploadQueue::all(device.db.connection())?;
            if revert {
                for write in pending.iter().rev() {
                    if let Err(error) = device.db.revert(&write.changeset) {
                        let error = Error::from(error);
                        if error.is_transient() {
                            return Err(error);
                        }
                        revert_failed = Some(error.to_string());
                        return Err(Error::Failed("撤回待上传失败".to_owned()));
                    }
                    for row in changeset::parse(&write.changeset)? {
                        device.effects.touch(row.table());
                    }
                }
            }
            change(device)?;
            let Device {
                db,
                uploads,
                recorder,
                synced,
                retired,
                effects,
                ..
            } = device;
            confirmed = uploads.rebase(db, pending, lmids, |db, changes| {
                replay(db, recorder, synced.declaration(), retired, effects, changes)
            })?;
            Ok(())
        });
        match (result, revert_failed) {
            (Ok(()), _) => Ok(Some(confirmed)),
            (Err(_), Some(cause)) => {
                self.effects
                    .report(format!("Syncline：本机的数据与待上传对不上（撤回失败），整份重拉：{cause}"));
                self.commit(fallback)?;
                Ok(None)
            }
            (Err(error), None) => Err(error),
        }
    }
}

/// 重放一条待上传（改到删掉的表与列的部分先去掉），返回新的改动集。重放不了（引用的行已被别处删掉、与云端的新值合起来违反约束）就是本机预测失败：
/// 记空改动集、留在待上传照常上传，由云端裁决。存储出错与 SQLite 回滚了整个事务才报错、中止这次收下
/// @see <https://github.com/rocicorp/mono/pull/6555>
fn replay(
    db: &mut Database,
    recorder: &Recorder,
    declaration: &Declaration,
    retired: &HashSet<String>,
    effects: &mut Effects,
    changes: &[Change],
) -> Result<Vec<u8>, Error> {
    db.connection().execute_batch("SAVEPOINT syncline_replay")?;
    let replayed = recorder.run(db, &without_retired(changes, retired, declaration), None);
    let connection = db.connection();
    match replayed {
        Ok(changeset) => {
            connection.execute_batch("RELEASE syncline_replay")?;
            for row in changeset::parse(&changeset)? {
                effects.touch(row.table());
            }
            Ok(changeset)
        }
        Err(error) => {
            if error.is_transient() || !db.in_transaction() {
                return Err(error);
            }
            connection.execute_batch("ROLLBACK TO syncline_replay; RELEASE syncline_replay")?;
            Ok(Vec::new())
        }
    }
}
