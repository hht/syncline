// C FFI interface between the native Rust sync engine (`rust/native`) and Swift.
#pragma once

typedef struct SynclineHandle SynclineHandle;

SynclineHandle *_Nonnull syncline_start(const char *_Nonnull path);
void syncline_send(const SynclineHandle *_Nonnull handle, const char *_Nonnull call);
char *_Nullable syncline_next(const SynclineHandle *_Nonnull handle);
void syncline_shutdown(const SynclineHandle *_Nonnull handle);
void syncline_free(SynclineHandle *_Nonnull handle);
char *_Nullable syncline_remove(const char *_Nonnull path);
void syncline_string_free(char *_Nonnull text);
