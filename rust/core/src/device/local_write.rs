//! 本机写：开保存点并开始记录；body 执行完结束记录、交出要按 Standard Schema 查的行；查过之后照「行怎么写」重做、连同改动集记进待上传；
//! 出错回滚到保存点。
//! 不该知道的：改动怎么记、怎么上传。

use super::Device;
use crate::changeset;
use crate::error::Error;
use crate::recorder::{Finished, Recorder, Stored};
use crate::statements::refuse_unless_write;

/// 本机写的保存点
const WRITE: &str = "syncline_write";

impl Device {
    /// 开始一次本机写：开保存点、开始记录
    ///
    /// # Errors
    /// 已有开着的；SQLite 开不了 session。
    pub fn begin_write(&mut self) -> Result<(), Error> {
        if self.writing {
            return Err(Error::Failed("已有开着的本机写".to_owned()));
        }
        self.db.connection().execute_batch(&format!("SAVEPOINT {WRITE}"))?;
        self.writing = true;
        self.finished = None;
        match self.recorder.start(&mut self.db) {
            Ok(recording) => {
                self.recording = Some(recording);
                Ok(())
            }
            Err(error) => {
                self.abort_write()?;
                Err(error)
            }
        }
    }

    /// 本机写里的一条语句能不能执行：只能读与改行，事务已被回滚就不再执行
    ///
    /// # Errors
    /// 没有开着的本机写；不能执行的语句；事务已被 SQLite 回滚。
    pub fn check_write(&self, sql: &str) -> Result<(), Error> {
        if !self.writing {
            return Err(Error::Failed("这次本机写已经结束".to_owned()));
        }
        refuse_unless_write(sql)?;
        if !self.db.in_transaction() {
            return Err(Error::Failed(crate::recorder::ROLLED_BACK.to_owned()));
        }
        Ok(())
    }

    /// body 执行完了：结束记录，给出要按 Standard Schema 查的行；查过之后调 `commit_write`，出错调 `abort_write`
    ///
    /// # Errors
    /// 没有开着的本机写；见 `Recorder::finish`。
    pub fn finish_write(&mut self) -> Result<Vec<Stored>, Error> {
        if !self.writing {
            return Err(Error::Failed("本机库已关闭，这次本机写已回滚".to_owned()));
        }
        let Finished {
            changes,
            recorded,
            local,
            rows,
        } = self.recorder.finish(&mut self.db, &mut self.recording)?;
        for table in &local {
            self.effects.touch(table);
        }
        if !changes.is_empty() {
            self.finished = Some((changes, recorded));
        }
        Ok(rows)
    }

    /// 提交本机写：改到同步表的照「行怎么写」重做，连同改动集记进待上传，释放保存点；改到的表与有了新的本机写记进副作用
    ///
    /// # Errors
    /// 见 `Recorder::run`、`UploadQueue::add`；出错时调用方调 `abort_write`。
    pub fn commit_write(&mut self) -> Result<(), Error> {
        if let Some((changes, recorded)) = self.finished.take() {
            let changeset = self.recorder.run(&mut self.db, &changes, Some(&recorded))?;
            self.uploads.add(self.db.connection(), &changes, &changeset)?;
            for change in changeset::parse(&changeset)? {
                self.effects.touch(change.table());
            }
            self.effects.wrote = true;
        }
        self.db.connection().execute_batch(&format!("RELEASE {WRITE}"))?;
        self.writing = false;
        Ok(())
    }

    /// 中止开着的本机写（出错、关库）：结束记录，回滚到这次写的保存点；结束记录出错也回滚。没有开着的什么也不做
    ///
    /// # Errors
    /// 结束记录或回滚出错。
    pub fn abort_write(&mut self) -> Result<(), Error> {
        if !self.writing {
            return Ok(());
        }
        self.writing = false;
        self.finished = None;
        self.effects.touched.clear();
        self.effects.wrote = false;
        let stopped = Recorder::stop(&mut self.db, &mut self.recording);
        if self.db.in_transaction() {
            self.db
                .connection()
                .execute_batch(&format!("ROLLBACK TO {WRITE}; RELEASE {WRITE}"))?;
        }
        stopped.map(|_| ())
    }

    /// 有没有开着的本机写
    #[must_use]
    pub fn writing(&self) -> bool {
        self.writing
    }
}
