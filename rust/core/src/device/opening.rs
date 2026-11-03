//! 打开设备：建好 Syncline 自己的表，把本机表升到这次的声明（删掉的表与列物理删、再声明的表整份重拉），
//! 认人（换了人先清掉上一个人的），拉到一半的不合用就作废。
//! 不该知道的：升级时怎么撤回与重放待上传、表怎么建。

use super::{Device, Options};
use crate::database::Database;
use crate::effects::Effects;
use crate::error::Error;
use crate::evolution::{redeclare, refuse_names, retire};
use crate::internal;
use crate::owner;
use crate::recorder::Recorder;
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::upload_queue::UploadQueue;
use crate::verifier::Verifier;
use std::collections::{HashMap, HashSet};

impl Device {
    /// 打开：建好 Syncline 自己的表，升级本机表、认人（换了人先清掉上一个人的），拉到一半的不合用就作废
    ///
    /// # Errors
    /// 声明了删掉的表与列、本机专用的表与同步表重名；上一个人还有没上传的写（`PendingWrites`）；读写库出错。出错时交还库
    pub fn open(db: Database, options: Options, random_uuid: Box<dyn FnMut() -> String>) -> Result<Self, (Database, Error)> {
        let Options {
            config,
            owner,
            discard_pending,
            checksum,
        } = options;
        let parts = (|| {
            refuse_names(&config.synced, &config.local_only, &config.retired)?;
            let connection = db.connection();
            internal::prepare(connection)?;
            let retired: HashSet<String> = config.retired.iter().cloned().collect();
            let synced = SyncedTables::new(connection, &config.synced, "", &retired)?;
            let verifier = checksum.map(Verifier::new).transpose()?;
            Ok((retired, synced, verifier))
        })();
        let (retired, synced, verifier) = match parts {
            Ok(parts) => parts,
            Err(error) => return Err((db, error)),
        };
        let local_only = config.local_only.iter().map(|table| table.name.clone()).collect();
        let recorder = match Recorder::new(db.connection(), config) {
            Ok(recorder) => recorder,
            Err(error) => return Err((db, error)),
        };
        let mut device = Device {
            db,
            recorder,
            uploads: UploadQueue::new(random_uuid),
            synced,
            stage: Stage::new(""),
            verifier,
            local_only,
            retired,
            wanted: None,
            recording: None,
            writing: false,
            finished: None,
            shared: HashMap::new(),
            effects: Effects::default(),
        };
        match device.settle_open(owner.as_deref(), discard_pending) {
            Ok(()) => Ok(device),
            Err(error) => Err((device.db, error)),
        }
    }

    /// 打开的后半：升级本机表、认人，拉到一半的不合用就作废
    fn settle_open(&mut self, owner: Option<&str>, discard_pending: bool) -> Result<(), Error> {
        self.upgrade()?;
        self.claim(owner, discard_pending)?;
        self.commit(|device| {
            // 影子表只在分块拉取途中有、与它的同步表一个样子：这次发布改了有影子表的同步表，或拉到一半时退回过更早的发布，拉到一半的作废、从头拉
            let db = device.db.connection();
            if !device.staging()? || !device.synced.shadows_fit(db)? {
                device.unstage()?;
            }
            Ok(())
        })
    }

    /// 打开时把本机表升到这次的声明：删掉的表与列物理删、再声明的表整份重拉、新出现的列从 _extra 还原。
    /// 先撤回待上传、升级后再重放；撤回失败就报出、不撤回照样升级、整份重拉
    fn upgrade(&mut self) -> Result<(), Error> {
        let names: Vec<String> = self.synced.declaration().keys().cloned().collect();
        let upgrade = move |device: &mut Device| -> Result<bool, Error> {
            let db = device.db.connection();
            retire(db, &device.retired)?;
            let back = redeclare(db, "", &names)?;
            device.synced.upgrade(db, &mut device.effects)?;
            Ok(back)
        };
        let fallback = upgrade.clone();
        self.onto(
            |device| {
                if upgrade(device)? {
                    device.refetch()?;
                }
                Ok(())
            },
            &HashMap::new(),
            true,
            move |device| {
                fallback(device)?;
                device.refetch()
            },
        )?;
        Ok(())
    }

    /// 这个空间的数据属于谁：换了人登录时，上一个的数据先清掉（库文件里也不留），同一个人再打开照常接着用；owner 不给就不管。
    /// 还有没上传的写、又没说丢弃就不清、报 `PendingWrites`
    fn claim(&mut self, owner: Option<&str>, discard_pending: bool) -> Result<(), Error> {
        let Some(owner) = owner else { return Ok(()) };
        let stored = owner::stored(self.db.connection(), "")?;
        if stored.as_deref() == Some(owner) {
            return Ok(());
        }
        if let Some(previous) = stored {
            owner::securely(
                self,
                |device| device.db.connection(),
                |device| {
                    let pending = UploadQueue::count(device.db.connection())?;
                    if pending > 0 && !discard_pending {
                        return Err(Error::PendingWrites {
                            owner: previous,
                            count: pending,
                        });
                    }
                    device.reset(true)?;
                    device
                        .db
                        .connection()
                        .execute("DELETE FROM _syncline_identity WHERE space = ''", [])?;
                    Ok(())
                },
            )?;
        }
        owner::record(self.db.connection(), "", owner)?;
        Ok(())
    }
}
