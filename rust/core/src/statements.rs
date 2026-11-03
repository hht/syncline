//! 接入方在本机库上能执行哪些语句：事务由 Syncline 开关、表结构由表定义管，
//! 所以只放行读（SELECT、WITH、VALUES）与本机写里的改行（INSERT、UPDATE、DELETE、REPLACE），别的一律拒绝。
//! 按去掉开头的空白、分号（空语句）与注释之后的第一个关键字认，用放行的清单不用拒绝的清单。
//! 不该知道的：语句从哪来、谁在执行它。
//! @see <https://sqlite.org/lang.html>

use crate::error::Error;

const READS: [&str; 3] = ["SELECT", "WITH", "VALUES"];
const WRITES: [&str; 7] = ["SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"];

/// 读本机库时这条语句该由 Syncline 管就报错
///
/// # Errors
/// 不是读。
pub fn refuse_unless_read(sql: &str) -> Result<(), Error> {
    refuse_unless(&READS, sql, "读本机库时")
}

/// 本机写里这条语句该由 Syncline 管就报错
///
/// # Errors
/// 不是读或改行。
pub fn refuse_unless_write(sql: &str) -> Result<(), Error> {
    refuse_unless(&WRITES, sql, "本机写里")
}

fn refuse_unless(allowed: &[&str], sql: &str, place: &str) -> Result<(), Error> {
    let keyword: String = leading(sql)
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_uppercase();
    if allowed.contains(&keyword.as_str()) {
        return Ok(());
    }
    Err(Error::Failed(format!(
        "{place}不能执行 {}，只能执行 {}：事务由 Syncline 开关，表结构由表定义管",
        if keyword.is_empty() { "空语句" } else { &keyword },
        allowed.join("、")
    )))
}

/// 去掉开头的空白、空语句（分号）与注释
fn leading(mut sql: &str) -> &str {
    loop {
        let trimmed = sql.trim_start_matches(|c: char| c.is_whitespace() || c == ';');
        if let Some(rest) = trimmed.strip_prefix("--") {
            sql = rest.find('\n').map_or("", |end| &rest[end + 1..]);
        } else if let Some(rest) = trimmed.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => sql = &rest[end + 2..],
                None => return trimmed,
            }
        } else {
            return trimmed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按去掉注释与空语句后的第一个关键字认() {
        assert!(refuse_unless_read(" ;-- 注释\n/* 块 */ select 1").is_ok());
        assert!(refuse_unless_read("PRAGMA query_only = 0").is_err());
        assert!(refuse_unless_write("insert into t values (1)").is_ok());
        assert!(refuse_unless_write("BEGIN").is_err());
        assert!(refuse_unless_write("/* 不闭合").is_err());
    }
}
