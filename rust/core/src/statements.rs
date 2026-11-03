//! Allowed statements integrators may execute on the local database: transactions are managed
//! by Syncline and schemas are governed by table definitions, so only reads (SELECT, WITH, VALUES)
//! and local write row mutations (INSERT, UPDATE, DELETE, REPLACE) are permitted; all other statements are rejected.
//! Identifies first keyword after stripping leading whitespace, semicolons (empty statements), and comments,
//! using an allowlist rather than a blocklist.
//! What it should not know: where statements come from or who executes them.
//! @see <https://sqlite.org/lang.html>

use crate::error::Error;

const READS: [&str; 3] = ["SELECT", "WITH", "VALUES"];
const WRITES: [&str; 7] = ["SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"];

/// Rejects statements not permitted during database reads
///
/// # Errors
/// Statement is not a read.
pub fn refuse_unless_read(sql: &str) -> Result<(), Error> {
    refuse_unless(&READS, sql, "when reading the local database")
}

/// Rejects statements not permitted during local writes
///
/// # Errors
/// Statement is not a read or row mutation.
pub fn refuse_unless_write(sql: &str) -> Result<(), Error> {
    refuse_unless(&WRITES, sql, "inside a local write")
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
        "{} is not allowed {place}; only {} are permitted: transactions are managed by Syncline and table schemas are governed by table definitions",
        if keyword.is_empty() { "empty statement" } else { &keyword },
        allowed.join(", ")
    )))
}

/// Strips leading whitespace, empty statements (semicolons), and comments
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
    fn identifies_first_keyword_after_stripping_comments_and_empty_statements() {
        assert!(refuse_unless_read(" ;-- comment\n/* block */ select 1").is_ok());
        assert!(refuse_unless_read("PRAGMA query_only = 0").is_err());
        assert!(refuse_unless_write("insert into t values (1)").is_ok());
        assert!(refuse_unless_write("BEGIN").is_err());
        assert!(refuse_unless_write("/* unclosed").is_err());
    }
}
