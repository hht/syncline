// Rust 的设备一侧（rust/native）给 Swift 的 C 接口；句柄与字符串的归属见 rust/native/src/ffi.rs
#pragma once

typedef struct SynclineHandle SynclineHandle;

SynclineHandle *_Nonnull syncline_start(const char *_Nonnull path);
void syncline_send(const SynclineHandle *_Nonnull handle, const char *_Nonnull call);
char *_Nullable syncline_next(const SynclineHandle *_Nonnull handle);
void syncline_shutdown(const SynclineHandle *_Nonnull handle);
void syncline_free(SynclineHandle *_Nonnull handle);
char *_Nullable syncline_remove(const char *_Nonnull path);
void syncline_string_free(char *_Nonnull text);
