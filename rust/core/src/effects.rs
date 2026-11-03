//! 一次操作要交给外面的副作用：改到的表（提交后报给订阅者，回滚的不报）、要报出的问题（接入方的出错回调，不中断同步）、
//! 被扣下的本机写、有了新的本机写、要收缩库文件。
//! 核心只记下，外层在提交后取走、报出。
//! 不该知道的：报给谁、怎么报。

use crate::change::Change;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Default, Debug)]
pub struct Effects {
    pub touched: BTreeSet<String>,
    pub reports: Vec<String>,
    /// 被云端扣下的本机写
    pub held: Vec<Held>,
    /// 有了新的本机写（连接据此推送）
    pub wrote: bool,
    /// 暂存的块刚清掉：外层分几步收缩库文件
    pub shrink: bool,
}

/// 被云端扣下的本机写：原因与原样的改动
#[derive(Debug, Serialize)]
pub struct Held {
    pub reason: String,
    pub changes: Vec<Change>,
}

impl Effects {
    pub fn touch(&mut self, table: &str) {
        self.touched.insert(table.to_owned());
    }

    pub fn report(&mut self, message: String) {
        self.reports.push(message);
    }
}
