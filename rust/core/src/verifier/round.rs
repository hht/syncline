//! 对一段：开始时记下设备这一刻的样子，一批批读本机的这一段算校验和，中途库变了、连接停了就作罢；读完与云端的比，
//! 对上了记下下一段从哪起，对不上报出、记下这一段的各部分等重下。
//! 不该知道的：什么时候该对、拉取带什么。

use super::{Moment, Progress, Verifier, state, update};
use crate::checksum::{self, BATCH, Position};
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::{Checksum, ChecksumPart, PullRange};
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

/// 正在对的一段：开头的状态（mark）、各张同步表的主键、云端给的、要读的各部分、读到哪、已算的和
pub(super) struct Running {
    start: String,
    keys: HashMap<String, Vec<String>>,
    expected: Checksum,
    parts: Vec<ChecksumPart>,
    part: usize,
    position: Option<Position>,
    sum: u32,
}

impl Verifier {
    /// 正在对一段
    #[must_use]
    pub fn running(&self) -> bool {
        self.running.is_some()
    }

    /// 开始对一段：能对（还能对、数据没在变、有云端给的这一版的）就记下开头，返回真；不能对返回假（作罢）
    ///
    /// # Errors
    /// 读库出错。
    pub fn begin(&mut self, db: &Connection, moment: &Moment) -> Result<bool, Error> {
        let mark = if moment.live { moment.mark.clone() } else { None };
        let (Some(start), Some(expected)) = (mark, self.expected_at(moment.cookie.as_ref()).cloned()) else {
            return Ok(false);
        };
        // 最后一段：云端不同步、本机还存着的表的行也算进来（云端那边是 0），残留的对得出来
        let mut parts = expected.parts.clone();
        if let Some(tables) = &expected.tables {
            parts.extend(checksum::others(db, moment.keys, tables)?);
        }
        self.running = Some(Running {
            start,
            keys: moment.keys.clone(),
            expected,
            parts,
            part: 0,
            position: None,
            sum: 0,
        });
        Ok(true)
    }

    /// 对一步（一批，或读完之后比一比）：库变了（连接、库都还在）这一段减半、作罢；不能对了作罢；对完了按对上没有记下
    ///
    /// # Errors
    /// 读写库出错（调用方报出、作罢）。
    pub fn step(&mut self, db: &Connection, moment: &Moment, effects: &mut Effects, now: f64) -> Result<Progress, Error> {
        let Some(mut running) = self.running.take() else {
            return Ok(Progress::Done(None));
        };
        if !moment.live || !Self::unchanged(db, &running, moment)? {
            return Ok(Progress::Done(None));
        }
        if let Some(part) = running.parts.get(running.part) {
            let (sum, next) = checksum::step(db, &running.keys, part, running.position.as_ref())?;
            running.sum = running.sum.wrapping_add(sum);
            if next.is_none() {
                running.part += 1;
            }
            running.position = next;
            self.running = Some(running);
            return Ok(Progress::More);
        }
        let expected = running.expected;
        if running.sum == expected.sum {
            self.passed(db, expected.next, now)?;
            return Ok(Progress::Done(Some(true)));
        }
        let ranges: Vec<PullRange> = running
            .parts
            .iter()
            .map(|part| PullRange {
                table: part.table.clone(),
                after: part.range.after.clone(),
                until: part.range.until.clone(),
            })
            .collect();
        let refetch = self.mismatched(db, &ranges, expected.next, expected.rows.max(BATCH), now)?;
        effects.report(format!(
            "Syncline：本机的数据与云端对不上（校验和 {}，云端 {}），{}",
            running.sum,
            expected.sum,
            if refetch {
                "按范围重下这一段"
            } else {
                "重下过仍对不上，跳过这一段"
            }
        ));
        Ok(Progress::Done(Some(false)))
    }

    /// 不对了（出错、库关了）：丢掉正在对的
    pub fn stop(&mut self) {
        self.running = None;
    }

    /// 还能接着对：库没变；变了（连接、库都还在）这一段减半
    fn unchanged(db: &Connection, running: &Running, moment: &Moment) -> Result<bool, Error> {
        if moment.mark.as_deref() == Some(running.start.as_str()) {
            return Ok(true);
        }
        if moment.live {
            let rows = state(db)?.rows.min(running.expected.rows);
            update(db, &[("rows", Value::Integer(BATCH.max(rows / 2)))])?;
        }
        Ok(false)
    }

    /// 对不上：重下过还对不上就只跳过这一段（返回假）；没重下过记下要按范围重下的几段，再对时要同样多的行（返回真）
    fn mismatched(&mut self, db: &Connection, parts: &[PullRange], next: Option<String>, rows: i64, now: f64) -> Result<bool, Error> {
        if state(db)?.repaired {
            self.passed(db, next, now)?;
            return Ok(false);
        }
        let ranges = serde_json::to_string(parts).map_err(|error| Error::Failed(error.to_string()))?;
        update(
            db,
            &[
                ("repaired", Value::Integer(1)),
                ("ranges", Value::Text(ranges)),
                ("rows", Value::Integer(rows)),
            ],
        )?;
        // 重下的拉取接着要这一段
        self.asked_at = f64::NEG_INFINITY;
        self.expected = None;
        Ok(true)
    }

    /// 这一段过了：最后一段是对完一轮，记下时刻、下一轮从头、从最长的段起；不是就记下下一段从哪起，接着就要
    fn passed(&mut self, db: &Connection, next: Option<String>, now: f64) -> rusqlite::Result<()> {
        match next {
            None => update(
                db,
                &[
                    ("at", Value::Real(now)),
                    ("repaired", Value::Integer(0)),
                    ("next", Value::Null),
                    ("rows", Value::Null),
                ],
            )?,
            Some(next) => {
                update(db, &[("repaired", Value::Integer(0)), ("next", Value::Text(next))])?;
                self.asked_at = f64::NEG_INFINITY;
            }
        }
        // 这一版的这一段不再对
        self.expected = None;
        Ok(())
    }
}
