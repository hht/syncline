//! Files that fail for tests (feature `testing`): a memory VFS whose file reads, writes, truncations, and syncs fail with `SQLITE_IOERR`
//! while injected faults fail file I/O (`faults::io_failing`), reaching failures only file I/O raises, such as rolling back to a
//! savepoint; databases on it are files with journals, unlike `:memory:` ones, whose journals never touch a VFS.
//! What this module should not know: which statement runs, or why I/O fails.
//! @see <https://sqlite.org/c3ref/vfs.html>
//! @see <https://docs.rs/crate/rsqlite-vfs/0.2.0/source/src/memvfs.rs>

use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_rs::vfs::{
    AccessMode, LockLevel, MemChunksFile, OpenOptions, OpenRequest, OpenedFile, SQLiteIoMethods, SQLiteVfs, SyncOptions, VfsError,
    VfsErrorCode, VfsFile, VfsResult, VfsStore, register_vfs,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Once;

/// Name of the VFS to open databases on.
pub const VFS: &str = "faulty";

/// Registers the VFS once.
///
/// # Panics
/// Panics if a VFS of the same name is already registered.
pub fn install() {
    static INSTALLED: Once = Once::new();
    #[expect(
        unsafe_code,
        reason = "registering a VFS hands SQLite raw pointers; wasm runs SQLite on one thread, and they live as long as the module"
    )]
    INSTALLED.call_once(|| {
        let registered = unsafe { register_vfs::<Io, Vfs>(VFS, Files::default(), false) };
        registered.expect("faulty VFS registers once").into_raw();
    });
}

fn checked() -> VfsResult<()> {
    if crate::faults::io_failing() {
        return Err(VfsError::new(VfsErrorCode::Io, "injected I/O fault".into()));
    }
    Ok(())
}

/// Files by name; anonymous ones (temporary files) are kept only by their handle.
#[derive(Default)]
struct Files(RefCell<HashMap<String, Rc<RefCell<MemChunksFile>>>>);

struct File(Rc<RefCell<MemChunksFile>>);

impl VfsFile for File {
    fn read(&mut self, buf: &mut [u8], offset: u64) -> VfsResult<usize> {
        checked()?;
        self.0.borrow_mut().read(buf, offset)
    }

    fn write(&mut self, buf: &[u8], offset: u64) -> VfsResult<()> {
        checked()?;
        self.0.borrow_mut().write(buf, offset)
    }

    // Required by VfsFile; these tests never shrink a file (journal mode TRUNCATE or vacuuming would)
    fn truncate(&mut self, size: u64) -> VfsResult<()> {
        checked()?;
        self.0.borrow_mut().truncate(size)
    }

    fn sync(&mut self, options: SyncOptions) -> VfsResult<()> {
        checked()?;
        self.0.borrow_mut().sync(options)
    }

    fn size(&self) -> VfsResult<u64> {
        self.0.borrow().size()
    }

    fn lock(&mut self, level: LockLevel) -> VfsResult<()> {
        self.0.borrow_mut().lock(level)
    }

    fn unlock(&mut self, level: LockLevel) -> VfsResult<()> {
        self.0.borrow_mut().unlock(level)
    }

    fn check_reserved_lock(&self) -> VfsResult<bool> {
        self.0.borrow().check_reserved_lock()
    }
}

struct Store;

impl VfsStore for Store {
    type File = File;
    type AppData = Files;

    fn open_file(files: &Files, request: OpenRequest<'_>) -> VfsResult<OpenedFile<File>> {
        let access = request.options.access();
        // SQLite opens nameless files for temporary storage (a statement journal spilling out of memory, temporary tables), which these
        // tests never need
        let Some(name) = request.filename else {
            return Ok(OpenedFile {
                file: File(Rc::default()),
                access,
            });
        };
        let file = files.0.borrow_mut().entry(name.path().to_owned()).or_default().clone();
        Ok(OpenedFile { file: File(file), access })
    }

    // SQLite deletes on close only temporary files, which have no name here; journals it deletes by name (`delete_file`)
    fn close_file(_files: &Files, _name: Option<&str>, _file: File, _options: OpenOptions) -> VfsResult<()> {
        Ok(())
    }

    fn access(files: &Files, name: &str, _mode: AccessMode) -> VfsResult<bool> {
        Ok(files.0.borrow().contains_key(name))
    }

    fn full_pathname(_files: &Files, name: &str) -> VfsResult<String> {
        Ok(name.to_owned())
    }

    fn delete_file(files: &Files, name: &str, _sync_dir: bool) -> VfsResult<()> {
        files.0.borrow_mut().remove(name);
        Ok(())
    }
}

struct Io;

impl SQLiteIoMethods for Io {
    type Store = Store;
}

struct Vfs;

impl SQLiteVfs<Io> for Vfs {
    type Os = WasmOsCallback;

    // Required by SQLiteVfs: sleeping, randomness, and the clock, which SQLite never asks the VFS for in these tests
    fn os(_files: &Files) -> &Self::Os {
        &WasmOsCallback
    }
}
