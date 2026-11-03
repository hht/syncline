//! 设备怎么对校验和：什么时候对、对不上怎么办。没对过（新装、被重置后）或上次对完一轮满一天就该对了：
//! 设备空闲时拉一次带 checksum 的，云端当场算出末块那一版里一段的；设备按云端给的主键范围读本机的同一段算出自己的，与它比，对上了接着要下一段，
//! 最后一段对上了是对完一轮。下一段从哪起记在库里，App 重启后接着对。一批批读（`step`），批与批之间由外层让出线程；中途库变了（本机写、收到改动）
//! 就作罢、这一段减半（至多减到一批）；连接停了、本机库关了也作罢，段不变。每天至多要 `rows_per_day` 行，用完了等到这一天过完。
//! 对不上就报出，记下这一段的各部分，下一次拉取按范围重下这一段，接着再对这一段；重下之后又对不上只报出、跳过这一段。这些都记在 `_syncline_verified`。
//! 时刻（毫秒）由外层每次给：核心不读时钟。
//! 不该知道的：本机的行怎么读、怎么按范围重下。

use crate::checksum::RANGE_ROWS;
use crate::error::Error;
use crate::protocol::{Checksum, Cookie, PullRange};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::Serialize;
use std::collections::HashMap;

/// 上次对完一轮多久之后再对；每天的行数也按这么长算
pub const INTERVAL: f64 = 24.0 * 3_600_000.0;

/// 在拉取里要了校验和还没对成：至少隔这么久再要（一次失败的拉取加一次退避的上限）
pub const ASK_AGAIN_AFTER: f64 = 60_000.0;

/// 每台设备每天至多要多少行
pub const ROWS_PER_DAY: i64 = 1_000_000;

/// `_syncline_verified` 的一行
struct State {
    at: f64,
    repaired: bool,
    next: Option<String>,
    rows: i64,
    day: f64,
    spent: i64,
    ranges: Option<String>,
}

/// 拉取要带的：从哪起的一段、至多几行，与要按范围重下的几段
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_rows: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranges: Option<Vec<PullRange>>,
}

mod round;

use round::Running;

/// 对一段时设备这一刻的样子：还能对（连接没停、库没关）、同步的数据的状态（有待上传、分块拉到一半时对不了，是 None）
pub struct Moment<'a> {
    pub live: bool,
    pub mark: Option<String>,
    pub cookie: Option<Cookie>,
    pub keys: &'a HashMap<String, Vec<String>>,
}

/// 对一步的结果：还要接着对，或对完了（对上了没有；作罢是 None）
pub enum Progress {
    More,
    Done(Option<bool>),
}

pub struct Verifier {
    rows_per_day: i64,
    /// 云端当场算的一段校验和与它对应的游标；只在内存里，游标变了就用不上
    expected: Option<(Cookie, Checksum)>,
    /// 上次在拉取里要校验和的时刻
    asked_at: f64,
    /// 这次拉取（分块时从第一块起）要的是从哪起的一段、至多几行
    asking: Option<(String, i64)>,
    /// 这次拉取带着按范围重下的哪几段（原样的 JSON）；末块落地后清掉它们
    ranges_asked: Option<String>,
    /// 这一天已要了、还没记进库里的行数：落地时在它的事务里记
    unrecorded: i64,
    running: Option<Running>,
}

impl Verifier {
    /// `rows_per_day` 是接入方给的数（JS 的 number），在这里认成正整数
    ///
    /// # Errors
    /// `rows_per_day` 不是正整数。
    pub fn new(rows_per_day: Option<f64>) -> Result<Self, Error> {
        let rows_per_day = match rows_per_day {
            None => ROWS_PER_DAY,
            // 正整数（NaN、无穷大的 fract 是 NaN，不算）；超出 i64 的照 `as` 取到 i64::MAX，一样是「不限」
            #[expect(clippy::cast_possible_truncation, reason = "超出 i64 的照 as 取到 i64::MAX，一样是「不限」")]
            Some(given) if given >= 1.0 && given.fract() == 0.0 => given as i64,
            Some(given) => return Err(Error::Failed(format!("checksumRowsPerDay 要是正整数：{given}"))),
        };
        Ok(Verifier {
            rows_per_day,
            expected: None,
            asked_at: f64::NEG_INFINITY,
            asking: None,
            ranges_asked: None,
            unrecorded: 0,
            running: None,
        })
    }

    /// 这次拉取要带的：新开一次拉取（不是接着拉）时带要按范围重下的几段；该对了、空闲（没有待上传）、离上次要隔了一阵时带 checksum 与 checksumRows，
    /// 要了就记下时刻、算进这一天的行数。接着拉时开头要了的接着要，但只在要了之后的一阵之内
    ///
    /// # Errors
    /// 读库出错；记下的几段读不出。
    pub fn request(&mut self, db: &Connection, idle: bool, continued: bool, now: f64) -> Result<Asked, Error> {
        if continued {
            return Ok(match &self.asking {
                Some((checksum, rows)) if now - self.asked_at < ASK_AGAIN_AFTER && idle => Asked {
                    checksum: Some(checksum.clone()),
                    checksum_rows: Some(*rows),
                    ranges: None,
                },
                _ => Asked::default(),
            });
        }
        let state = state(db)?;
        self.ranges_asked.clone_from(&state.ranges);
        let ranges = state
            .ranges
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|error| Error::Failed(error.to_string()))?;
        self.asking = None;
        let mut asked = Asked {
            ranges,
            ..Asked::default()
        };
        if now - self.asked_at >= ASK_AGAIN_AFTER && self.due(&state, now) && idle {
            let rows = state.rows.min(self.budget(&state, now).2);
            self.asking = Some((state.next.clone().unwrap_or_default(), rows));
            self.asked_at = now;
            self.unrecorded += rows;
            asked.checksum = Some(state.next.unwrap_or_default());
            asked.checksum_rows = Some(rows);
        }
        Ok(asked)
    }

    /// 该为校验和拉一次了：对不上要按范围重下，或还没有 cookie 这一版的、空闲、离上次要隔了一阵、该对了
    ///
    /// # Errors
    /// 读库出错。
    pub fn wants(&self, db: &Connection, cookie: Option<&Cookie>, idle: bool, now: f64) -> Result<bool, Error> {
        let state = state(db)?;
        if state.ranges.is_some() {
            return Ok(true);
        }
        Ok(self.expected_at(cookie).is_none() && idle && now - self.asked_at >= ASK_AGAIN_AFTER && self.due(&state, now))
    }

    /// 拉取的末块落地了：这次带着的几段已重下，之后又记下的别的段留着
    ///
    /// # Errors
    /// 写库出错。
    pub fn pulled(&mut self, db: &Connection) -> rusqlite::Result<()> {
        if let Some(ranges) = self.ranges_asked.take() {
            db.execute(
                "UPDATE _syncline_verified SET ranges = NULL WHERE space = '' AND ranges = ?",
                [ranges],
            )?;
        }
        Ok(())
    }

    /// 收下的改动落地到了 cookie（在落地的事务里）：这一天要了的行数记进库里；末块带着这一版里一段的校验和就记下，等着对
    ///
    /// # Errors
    /// 读写库出错。
    pub fn advanced(&mut self, db: &Connection, cookie: Cookie, checksum: Option<Checksum>, now: f64) -> Result<(), Error> {
        if self.unrecorded > 0 {
            let (day, spent, _) = self.budget(&state(db)?, now);
            update(db, &[("day", Value::Real(day)), ("spent", Value::Integer(spent))])?;
            self.unrecorded = 0;
        }
        if let Some(checksum) = checksum {
            self.expected = Some((cookie, checksum));
        }
        Ok(())
    }

    /// 被重置了（游标没了、整份重拉）：整份拉完从头再对一轮，这次整份拉取就要；要重下的段不用再下，这一天的行数照算
    ///
    /// # Errors
    /// 写库出错。
    pub fn reset(&mut self, db: &Connection) -> rusqlite::Result<()> {
        self.asked_at = f64::NEG_INFINITY;
        update(
            db,
            &[
                ("at", Value::Integer(0)),
                ("repaired", Value::Integer(0)),
                ("next", Value::Null),
                ("rows", Value::Null),
                ("ranges", Value::Null),
            ],
        )
    }

    fn expected_at(&self, cookie: Option<&Cookie>) -> Option<&Checksum> {
        self.expected
            .as_ref()
            .filter(|(at, _)| Some(at) == cookie)
            .map(|(_, checksum)| checksum)
    }

    /// 该对了：没对过、被重置后，或上次对完一轮满一天；这一天的行数还没用完
    fn due(&self, state: &State, now: f64) -> bool {
        now - state.at >= INTERVAL && self.budget(state, now).2 > 0
    }

    /// 这一天从什么时刻起、已要了几行（含还没记进库里的）、还能要几行：上一天过完了从现在起重新算
    fn budget(&self, state: &State, now: f64) -> (f64, i64, i64) {
        let fresh = now - state.day >= INTERVAL;
        let used = if fresh { 0 } else { state.spent } + self.unrecorded;
        (if fresh { now } else { state.day }, used, self.rows_per_day - used)
    }
}

fn state(db: &Connection) -> rusqlite::Result<State> {
    let row = db
        .query_row(
            "SELECT at, repaired, next, rows, day, spent, ranges FROM _syncline_verified WHERE space = ''",
            [],
            |row| {
                Ok(State {
                    at: row.get::<_, Option<f64>>(0)?.unwrap_or(0.0),
                    repaired: row.get::<_, Option<i64>>(1)? == Some(1),
                    next: row.get(2)?,
                    rows: row.get::<_, Option<i64>>(3)?.unwrap_or(RANGE_ROWS),
                    day: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                    spent: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    ranges: row.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(State {
        at: 0.0,
        repaired: false,
        next: None,
        rows: RANGE_ROWS,
        day: 0.0,
        spent: 0,
        ranges: None,
    }))
}

/// 改记着的几项（还没有这一行就先插一行默认的）
fn update(db: &Connection, fields: &[(&str, Value)]) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO _syncline_verified (space, at, repaired) VALUES ('', 0, 0)",
        [],
    )?;
    let sets: Vec<String> = fields.iter().map(|(name, _)| format!("{name} = ?")).collect();
    db.execute(
        &format!("UPDATE _syncline_verified SET {} WHERE space = ''", sets.join(", ")),
        params_from_iter(fields.iter().map(|(_, value)| value)),
    )?;
    Ok(())
}
