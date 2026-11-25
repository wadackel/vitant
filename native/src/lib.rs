//! Copies the worker process. A whole-file run needs a process that has run
//! nothing of the project yet; a copy of one taken at that point is that,
//! without starting Node, Vitest and the test environment again.
//!
//! Node has no call for this: `child_process.fork` starts a new process.

#![cfg(unix)]

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;

// libuv, as the node binary that loads this library exports it. The event
// loop holds kernel objects a copy does not get.
unsafe extern "C" {
    fn uv_default_loop() -> *mut c_void;
    fn uv_loop_fork(event_loop: *mut c_void) -> libc::c_int;
}

/// What a copy tells the process it was copied from. The page is mapped
/// shared, so both see it; a copy has its own of everything else. Two
/// processes read and write it at once, hence the atomics: the numbers are
/// `f64` bit patterns.
#[repr(C)]
struct Beat {
    /// CPU time the copy had used at its last heartbeat, in milliseconds.
    cpu_ms: AtomicU64,
    /// How much more it may use before the next one; 0 while no limit is set.
    limit_ms: AtomicU64,
    /// How long by the clock a stretch must also last before it is ended; 0 for no such floor.
    floor_ms: AtomicU64,
    beats: AtomicU64,
    /// 1 once the copy has written its verdict.
    done: AtomicU64,
}

impl Beat {
    fn clear(&self) {
        self.cpu_ms.store(0f64.to_bits(), Ordering::Relaxed);
        self.limit_ms.store(0f64.to_bits(), Ordering::Relaxed);
        self.floor_ms.store(0f64.to_bits(), Ordering::Relaxed);
        self.beats.store(0, Ordering::Relaxed);
        self.done.store(0, Ordering::Relaxed);
    }
}

static BEAT: AtomicPtr<Beat> = AtomicPtr::new(ptr::null_mut());

/// The shared page, mapped on first use.
fn beat() -> Result<&'static Beat> {
    shared(&BEAT)
}

/// Turns of the event loop of a copy that runs a test file as a worker
/// would, and of the copies it makes. Not `Beat`, which each copy it makes
/// clears for itself.
#[repr(C)]
struct Alive {
    turns: AtomicU64,
}

static ALIVE: AtomicPtr<Alive> = AtomicPtr::new(ptr::null_mut());

fn alive() -> Result<&'static Alive> {
    shared(&ALIVE)
}

/// A page mapped shared with every process this one copies from here on,
/// on first use. `T` is integers and valid when zeroed, as fresh pages are.
fn shared<T>(slot: &AtomicPtr<T>) -> Result<&'static T> {
    let known = slot.load(Ordering::Acquire);
    if !known.is_null() {
        // SAFETY: set below to a mapping that is never unmapped.
        return Ok(unsafe { &*known });
    }
    // SAFETY: an anonymous mapping of one `T`.
    let mapped = unsafe {
        libc::mmap(
            ptr::null_mut(),
            size_of::<T>(),
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANON,
            -1,
            0,
        )
    };
    if mapped == libc::MAP_FAILED {
        return Err(os_error("mmap"));
    }
    slot.store(mapped.cast(), Ordering::Release);
    // SAFETY: as above.
    Ok(unsafe { &*mapped.cast::<T>() })
}

fn os_error(call: &str) -> Error {
    Error::from_reason(format!("{call}: {}", std::io::Error::last_os_error()))
}

/// Runs a system call again for as long as a signal cuts it short.
fn uninterrupted(mut call: impl FnMut() -> libc::c_int) -> libc::c_int {
    loop {
        let result = call();
        if result != -1 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return result;
        }
    }
}

/// What a copy is to find room for in the machine's memory before it is
/// made, beside the other copies made with one.
#[napi(object)]
pub struct Room {
    /// What the copy is expected to come to hold that no other process shares, in bytes.
    pub need: f64,
    /// What is to be left to the rest of the machine, in bytes.
    pub spare: f64,
    /// The most the copies made with a room may hold together, in bytes; 0 for no such limit.
    pub ceiling: f64,
    /// The file that lists those copies, and the processes waiting to make one.
    pub registry: String,
}

/// Copies this process. Returns 0 in the copy, whose event loop is rebuilt,
/// and the copy's process id in the process that was copied.
///
/// `lock` is a file descriptor to hold a lock on for the time of the call: the
/// kernel makes copies one at a time, and processes that all try at once
/// spend their time waiting on one another inside it. With a `room`, the
/// copy is made once the machine has that room for it, see `find_room`.
#[napi]
pub fn fork(lock: i32, room: Option<Room>) -> Result<i32> {
    let shared = beat()?;
    // Mapped before the copy is made, so that the two share it.
    alive()?;
    // No copy exists that could be writing: the one before was waited for.
    shared.clear();
    let room = room.filter(|room| room.need > 0.0);
    let mut listed = match &room {
        Some(room) => find_room(lock, room)?,
        None => {
            // SAFETY: plain system calls on a descriptor the caller owns.
            unsafe { uninterrupted(|| libc::flock(lock, libc::LOCK_EX)) };
            Vec::new()
        }
    };
    #[cfg(target_os = "linux")]
    if let Err(error) = inherit_everything() {
        if let Some(room) = &room {
            // SAFETY: plain system call.
            let me = unsafe { libc::getpid() };
            listed.retain(|entry| entry.pid != me || !entry.waiting);
            write_registry(&room.registry, &listed);
        }
        // SAFETY: as above.
        unsafe { libc::flock(lock, libc::LOCK_UN) };
        return Err(error);
    }
    // SAFETY: the copy has only the calling thread. The caller sees to it
    // that no other thread is needed and none is in the middle of anything
    // (see the runner); what follows in the copy is plain system calls.
    unsafe {
        #[cfg(not(target_os = "linux"))]
        let copied_from = libc::getpid();
        let pid = libc::fork();
        if pid == 0 {
            // A copy whose event loop could not be rebuilt would go on with
            // the kernel objects of the process it was copied from.
            if uv_loop_fork(uv_default_loop()) != 0 {
                libc::_exit(70);
            }
            // A copy must not outlive the process that watches it.
            #[cfg(target_os = "linux")]
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            #[cfg(not(target_os = "linux"))]
            end_with(copied_from);
            return Ok(0);
        }
        // Read before the next call replaces it.
        let failure = (pid < 0).then(|| os_error("fork"));
        if let Some(room) = &room {
            let me = libc::getpid();
            listed.retain(|entry| entry.pid != me || !entry.waiting);
            if pid > 0 {
                listed.push(Entry { pid, started: started(pid).unwrap_or(0), need: room.need, waiting: false });
            }
            write_registry(&room.registry, &listed);
        }
        libc::flock(lock, libc::LOCK_UN);
        match failure {
            Some(error) => Err(error),
            None => Ok(pid),
        }
    }
}

/// Waits until the machine has room for this process to go on to hold
/// `room.need` that no other process shares, as it does before it runs a
/// test file itself, and lists it among the processes that hold such room.
#[napi]
pub fn room(lock: i32, room: Room) -> Result<()> {
    if room.need <= 0.0 {
        return Ok(());
    }
    let mut listed = find_room(lock, &room)?;
    // SAFETY: plain system call.
    let me = unsafe { libc::getpid() };
    listed.retain(|entry| entry.pid != me);
    listed.push(Entry { pid: me, started: started(me).unwrap_or(0), need: room.need, waiting: false });
    write_registry(&room.registry, &listed);
    // SAFETY: plain system call on a descriptor the caller owns.
    unsafe { libc::flock(lock, libc::LOCK_UN) };
    Ok(())
}

/// A line of the registry: a process that holds room, or one waiting for it.
struct Entry {
    pid: i32,
    /// When the process started, see `started`: the system hands an ended process's id to a new one.
    started: u64,
    need: f64,
    waiting: bool,
}

fn read_registry(path: &str) -> Vec<Entry> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_ascii_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let started = fields.next()?.parse().ok()?;
            let need = fields.next()?.parse().ok()?;
            let waiting = fields.next()? == "waiting";
            Some(Entry { pid, started, need, waiting })
        })
        // A process that is gone has given its memory back.
        .filter(|entry| started(entry.pid) == Some(entry.started))
        .collect()
}

fn write_registry(path: &str, entries: &[Entry]) {
    let text: String = entries
        .iter()
        .map(|entry| format!("{} {} {} {}\n", entry.pid, entry.started, entry.need, if entry.waiting { "waiting" } else { "running" }))
        .collect();
    // Under the lock, which every writer holds: no one reads it half written.
    let _ = std::fs::write(path, text);
}

/// Takes the lock once the machine has room for a process that is to hold
/// `room.need`, and returns the registry as it then stands. Room is what the
/// machine has available, less what the processes that hold room are still
/// expected to take on top of what they hold, less what the processes that
/// began to wait earlier need, and with `room.spare` left over. A process
/// goes whatever the room where nobody waits ahead and every other that
/// holds room waits as well: then none of them would give memory back.
/// The lock is not held while waiting, so that copies that need no room are
/// made meanwhile, and the wait counts as a turn of the event loop for
/// `host`, which would otherwise take a process waiting this way for one stuck.
fn find_room(lock: i32, room: &Room) -> Result<Vec<Entry>> {
    // SAFETY: plain system call.
    let me = unsafe { libc::getpid() };
    let mut registered = false;
    let lock_registry = || {
        // SAFETY: plain system calls on a descriptor the caller owns.
        unsafe { uninterrupted(|| libc::flock(lock, libc::LOCK_EX)) };
        let mut listed = read_registry(&room.registry);
        // A process that waits for room, for itself or a copy, takes on
        // nothing more meanwhile, and one that makes copies has them hold
        // what it would have gone on to: what it was to take on is not kept
        // from the others.
        for entry in listed.iter_mut().filter(|entry| entry.pid == me && !entry.waiting) {
            entry.need = 0.0;
        }
        listed
    };
    let unlock = || {
        // SAFETY: as above.
        unsafe { libc::flock(lock, libc::LOCK_UN) };
    };
    loop {
        let listed = lock_registry();
        if has_room(&listed, me, room, None) {
            return Ok(listed);
        }
        // What the others hold is read without the lock: reading it walks
        // their memory, tens of milliseconds for gigabytes, and every copy
        // of the machine is made under the lock.
        let others: Vec<i32> = listed.iter().filter(|entry| !entry.waiting && entry.pid != me).map(|entry| entry.pid).collect();
        unlock();
        let held: Vec<(i32, f64)> = others.into_iter().map(|pid| (pid, held_bytes(pid).unwrap_or(0.0))).collect();
        let mut listed = lock_registry();
        if has_room(&listed, me, room, Some(&held)) {
            return Ok(listed);
        }
        if !registered {
            listed.push(Entry { pid: me, started: started(me).unwrap_or(0), need: room.need, waiting: true });
            registered = true;
        }
        write_registry(&room.registry, &listed);
        unlock();
        alive()?.turns.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether `room` fits, see `find_room`. Without `held`, what each process
/// that holds room is still to take is taken to be all it was to hold, which
/// settles most cases without reading what they hold; a process missing
/// from `held` began after it was read and holds next to nothing yet.
fn has_room(listed: &[Entry], me: i32, room: &Room, held: Option<&[(i32, f64)]>) -> bool {
    let ahead: Vec<&Entry> = listed.iter().take_while(|entry| entry.pid != me || !entry.waiting).filter(|entry| entry.waiting).collect();
    // Of this process, what it holds is in what is available, and while it
    // waits it takes on nothing more.
    let running: Vec<&Entry> = listed.iter().filter(|entry| !entry.waiting && entry.pid != me).collect();
    // Those that wait give nothing back by waiting: where every other
    // process that holds room waits too, the first in line goes.
    let waits = |pid: i32| listed.iter().any(|entry| entry.waiting && entry.pid == pid);
    if ahead.is_empty() && running.iter().all(|entry| waits(entry.pid)) {
        return true;
    }
    let Some(available) = available_bytes() else { return true };
    let wanted = room.need + ahead.iter().map(|entry| entry.need).sum::<f64>();
    let fits = |coming: f64, holding: f64| {
        let free = available - room.spare;
        let free = if room.ceiling > 0.0 { free.min(room.ceiling - holding) } else { free };
        free - coming >= wanted
    };
    let Some(held) = held else {
        return room.ceiling == 0.0 && fits(running.iter().map(|entry| entry.need).sum(), 0.0);
    };
    let held_by = |pid: i32| held.iter().find(|(known, _)| *known == pid).map_or(0.0, |(_, bytes)| *bytes);
    let coming = running.iter().map(|entry| (entry.need - held_by(entry.pid)).max(0.0)).sum();
    fits(coming, running.iter().map(|entry| held_by(entry.pid)).sum())
}

/// When a process started, in the system's own units; none once it is gone.
#[cfg(target_os = "macos")]
fn started(pid: i32) -> Option<u64> {
    // SAFETY: the kernel fills the structure, which is plain numbers.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
        if libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) != size {
            return None;
        }
        Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }
}

#[cfg(not(target_os = "macos"))]
fn started(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name, in parentheses, may hold spaces; the start time is the 22nd field.
    let (_, rest) = stat.rsplit_once(')')?;
    // A process that has ended and not been waited for holds nothing any more.
    let mut fields = rest.split_ascii_whitespace();
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18)?.parse().ok()
}

/// The process this one is a copy of.
#[cfg(not(target_os = "linux"))]
static COPIED_FROM: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(not(target_os = "linux"))]
extern "C" fn end_if_orphaned(_: libc::c_int) {
    // SAFETY: both calls may be made from a signal handler.
    unsafe {
        if libc::getppid() != COPIED_FROM.load(Ordering::Relaxed) {
            libc::_exit(1);
        }
    }
}

/// Has this process, a copy, end once the process it was copied from is
/// gone. Only Linux has a call for that. A check the copy makes in its
/// event loop is not made by one a mutant keeps in a loop, which is the copy
/// that then runs for good on a core of its own, and a thread that looks
/// would be one more a copy of the copy is without: the kernel interrupts
/// the copy on a timer instead, whatever it is doing.
///
/// # Safety
/// For the copy, straight after `fork`.
#[cfg(not(target_os = "linux"))]
unsafe fn end_with(copied_from: libc::pid_t) {
    COPIED_FROM.store(copied_from, Ordering::Relaxed);
    // SAFETY: plain system calls; the structures are plain numbers, valid
    // when zeroed, and a system call the signal cuts short is started again.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = end_if_orphaned as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGALRM, &action, ptr::null_mut());
        let second = libc::timeval { tv_sec: 1, tv_usec: 0 };
        // A copy does not get the timer of the process it was copied from.
        libc::setitimer(libc::ITIMER_REAL, &libc::itimerval { it_interval: second, it_value: second }, ptr::null_mut());
    }
}

/// On Linux, Node builds V8 to mark the memory it allocates, the JavaScript
/// heap with it, as not to be given to a child process (`MADV_DONTFORK`, V8's
/// `v8_enable_private_mapping_fork_optimization`), so a copy would start
/// without the program it is a copy of. The mark is taken off every mapping.
/// V8 puts it on what it allocates next, so this is done before each copy.
///
/// It cannot tell V8's mark from one another library put on memory of its
/// own; such a library's memory is copied too.
#[cfg(target_os = "linux")]
fn inherit_everything() -> Result<()> {
    let maps = std::fs::read_to_string("/proc/self/maps")
        .map_err(|error| Error::from_reason(format!("/proc/self/maps: {error}")))?;
    for line in maps.lines() {
        let Some((range, _)) = line.split_once(' ') else { continue };
        let Some((from, to)) = range.split_once('-') else { continue };
        let (Ok(from), Ok(to)) = (usize::from_str_radix(from, 16), usize::from_str_radix(to, 16)) else { continue };
        // SAFETY: advice about mappings of this process. It changes what a
        // child gets, nothing here; the kernel refuses it for the few
        // special mappings it does not apply to, which is fine.
        unsafe { libc::madvise(from as *mut c_void, to - from, libc::MADV_DOFORK) };
    }
    Ok(())
}

/// The id of this process. Node reads it once when it starts, so a copy
/// would go on answering with that of the process it was copied from.
#[napi]
pub fn pid() -> i32 {
    // SAFETY: plain system call.
    unsafe { libc::getpid() }
}

/// The threads of this process, the calling one included, each named by
/// something no later thread of the process is named by: on macOS the
/// kernel's id of it, which is never given out again, and on Linux its id
/// with the time it started, since Linux gives an ended thread's id to a new
/// one as it does a process id.
#[napi]
pub fn threads() -> Result<Vec<String>> {
    Ok(listed_threads()?.into_iter().map(|(id, _)| id).collect())
}

/// The threads of libuv's pool, named as `threads` names them. libuv names
/// each `libuv-worker` as it starts, and starts the pool again in a copy
/// that uses it.
#[napi]
pub fn pool_threads() -> Result<Vec<String>> {
    Ok(listed_threads()?.into_iter().filter(|(_, name)| name == POOL_THREAD).map(|(id, _)| id).collect())
}

const POOL_THREAD: &str = "libuv-worker";

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> libc::kern_return_t;
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn listed_threads() -> Result<Vec<(String, String)>> {
    // SAFETY: the kernel fills the list and the structures, which are plain
    // numbers; each port it hands over and the list itself are given back.
    unsafe {
        let task = libc::mach_task_self();
        let mut list: libc::thread_act_array_t = ptr::null_mut();
        let mut count: libc::mach_msg_type_number_t = 0;
        if libc::task_threads(task, &mut list, &mut count) != libc::KERN_SUCCESS {
            return Err(Error::from_reason("task_threads failed"));
        }
        let ports = std::slice::from_raw_parts(list, count as usize);
        let mut ids = Vec::with_capacity(ports.len());
        for &port in ports {
            // A thread that ended since the list was made has no information left.
            let mut info: libc::thread_identifier_info = std::mem::zeroed();
            let mut size = libc::THREAD_IDENTIFIER_INFO_COUNT;
            if libc::thread_info(port, libc::THREAD_IDENTIFIER_INFO as u32, (&raw mut info).cast(), &mut size) == libc::KERN_SUCCESS {
                let mut extended: libc::thread_extended_info = std::mem::zeroed();
                let mut size = libc::THREAD_EXTENDED_INFO_COUNT;
                let name = if libc::thread_info(port, libc::THREAD_EXTENDED_INFO as u32, (&raw mut extended).cast(), &mut size) == libc::KERN_SUCCESS {
                    std::ffi::CStr::from_ptr(extended.pth_name.as_ptr()).to_string_lossy().into_owned()
                } else {
                    String::new()
                };
                ids.push((info.thread_id.to_string(), name));
            }
            mach_port_deallocate(task, port);
        }
        libc::vm_deallocate(task, list as libc::vm_address_t, size_of_val(ports) as libc::vm_size_t);
        Ok(ids)
    }
}

#[cfg(not(target_os = "macos"))]
fn listed_threads() -> Result<Vec<(String, String)>> {
    let unreadable = |error: std::io::Error| Error::from_reason(format!("/proc/self/task: {error}"));
    let mut ids = Vec::new();
    for task in std::fs::read_dir("/proc/self/task").map_err(unreadable)? {
        let task = task.map_err(unreadable)?;
        let Some(id) = task.file_name().to_str().map(str::to_owned) else { continue };
        // A thread that ended since the directory was read has no stat left.
        let Ok(stat) = std::fs::read_to_string(task.path().join("stat")) else { continue };
        // The name, in parentheses, may hold spaces; the fields are counted
        // from its end, the start time being the 22nd.
        let Some((head, rest)) = stat.rsplit_once(')') else { continue };
        let Some(started) = rest.split_ascii_whitespace().nth(19) else { continue };
        let name = head.split_once('(').map_or("", |(_, name)| name);
        ids.push((format!("{id}:{started}"), name.to_owned()));
    }
    Ok(ids)
}

/// What `echo` asks the thread `start_echo` starts, plus one, or 0.
static ASKED: AtomicU64 = AtomicU64::new(0);
/// What that thread answered, plus one, or 0.
static ANSWERED: AtomicU64 = AtomicU64::new(0);
static ECHOING: std::sync::Once = std::sync::Once::new();

/// Starts a thread that hands back what `echo` gives it, as a native module's
/// own threads do the work it is asked for. For `fixtures/walk` alone, whose
/// tests need a thread that a copy made after it started does not have;
/// nothing in `src/` calls it. Both sides
/// look every millisecond: a thread woken through the kernel would, in such
/// a copy, end the process on macOS rather than leave the test waiting.
#[napi]
pub fn start_echo() {
    ECHOING.call_once(|| {
        std::thread::spawn(|| {
            loop {
                let asked = ASKED.swap(0, Ordering::AcqRel);
                if asked != 0 {
                    ANSWERED.store(asked, Ordering::Release);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
    });
}

/// The work `echo` hands libuv's pool. For `fixtures/walk` alone, as `start_echo` is; nothing in `src/` uses either.
pub struct Echo {
    value: u32,
}

impl Task for Echo {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<u32> {
        if !ECHOING.is_completed() {
            return Err(Error::from_reason("no echo thread was started"));
        }
        ANSWERED.store(0, Ordering::Release);
        ASKED.store(u64::from(self.value) + 1, Ordering::Release);
        loop {
            let answered = ANSWERED.swap(0, Ordering::AcqRel);
            if answered != 0 {
                return Ok((answered - 1) as u32);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn resolve(&mut self, _: Env, value: u32) -> Result<u32> {
        Ok(value)
    }
}

/// Has the thread `start_echo` started hand `value` back, waiting for it on
/// libuv's pool. For `fixtures/walk` alone; nothing in `src/` calls it.
#[napi]
pub fn echo(value: u32) -> AsyncTask<Echo> {
    AsyncTask::new(Echo { value })
}

/// In a copy: its CPU time so far, how much more it may use before it says
/// so again, and how long by the clock that stretch must at least last.
#[napi]
pub fn heartbeat(cpu_ms: f64, limit_ms: f64, floor_ms: f64) -> Result<()> {
    let shared = beat()?;
    shared.cpu_ms.store(cpu_ms.to_bits(), Ordering::Relaxed);
    shared.limit_ms.store(limit_ms.to_bits(), Ordering::Relaxed);
    shared.floor_ms.store(floor_ms.to_bits(), Ordering::Relaxed);
    shared.beats.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// In a copy: its verdict is written.
#[napi]
pub fn done() -> Result<()> {
    beat()?.done.store(1, Ordering::Relaxed);
    Ok(())
}

/// How a copy ended.
#[napi]
pub enum Ended {
    /// By itself, having written its verdict.
    Done,
    /// Stopped for using more CPU time than it may without a heartbeat: it
    /// blocks, which is a verdict.
    Blocked,
    /// Stopped for holding more memory than it may, lest it take the machine
    /// with it. Not a verdict: the suite sets no such limit, and a run that
    /// holds that much and then ends passes there.
    Memory,
    /// Without a verdict. It ended on its own, as it does once it is over
    /// its time by the clock; or it sat without using CPU time or returning
    /// to its event loop, as one waiting for a thread it does not have
    /// would, and was stopped.
    Lost,
}

/// The most the copy `supervise` last waited for was seen to hold that no
/// other process shares, in bytes, see `held_bytes`.
static PEAK: AtomicU64 = AtomicU64::new(0);

/// How long a copy runs before what it holds is first read, and the least time between two reads, see `supervise`.
const WEIGH_EVERY: Duration = Duration::from_millis(250);

/// See `PEAK`.
#[napi]
pub fn held_peak() -> f64 {
    f64::from_bits(PEAK.load(Ordering::Relaxed))
}

/// Waits for a copy to end, without running this process's event loop: a
/// message on a channel both share has to reach the copy. The copy has no
/// thread to watch it, so the watching is done here.
#[napi]
pub fn supervise(pid: i32, stuck_ms: f64, resident_limit: f64) -> Result<Ended> {
    // Zero and below name groups of processes to `waitpid` and `kill`.
    if pid <= 0 {
        return Err(Error::from_reason(format!("not a process id: {pid}")));
    }
    let shared = beat()?;
    let started = Instant::now();
    let mut beats = 0;
    let mut beat_at = started;
    let mut beat_cpu = 0.0;
    // When a heartbeat was first seen here, which is after it was made: the
    // stretch since reads as shorter than it is, and is ended later.
    let mut beat_seen = started;
    let mut checked = started;
    let mut peak = 0.0f64;
    let mut weighed = started;
    let mut weigh_every = WEIGH_EVERY;
    let ended = loop {
        let mut status = 0;
        // SAFETY: plain system call on a child of this process.
        let ended = unsafe { uninterrupted(|| libc::waitpid(pid, &mut status, libc::WNOHANG)) };
        if ended != 0 {
            // Either the copy, or an error saying it is no child of this
            // process any more; it wrote its verdict or it did not.
            let wrote = shared.done.load(Ordering::Relaxed) == 1;
            break if ended == pid && wrote { Ended::Done } else { Ended::Lost };
        }
        std::thread::sleep(Duration::from_millis(2));
        if checked.elapsed() < Duration::from_millis(20) {
            continue;
        }
        checked = Instant::now();
        // Reading it walks the copy's memory, and on macOS holds the copy up
        // while it does: weighed from 20 ms on, ufo's copies took twice as
        // long, 34 ms at the median against 18 ms. Those that are over by
        // then are not weighed, and the rest seldom enough to cost a fiftieth.
        if weighed.elapsed() >= weigh_every {
            weighed = Instant::now();
            if let Some(held) = held_bytes(pid) {
                peak = peak.max(held);
            }
            weigh_every = (weighed.elapsed() * 50).max(WEIGH_EVERY);
        }
        // A copy can take a gigabyte a second, and as many copies as there
        // are workers do so at once when mutants next to each other in the
        // source all do: the limits on time come after the machine is out
        // of memory.
        if resident_limit > 0.0 && resident_bytes(pid).is_some_and(|held| held > resident_limit) {
            stop(pid);
            break Ended::Memory;
        }
        // Without its CPU time the copy cannot be judged here; it ends itself by the clock.
        let Some(cpu) = cpu_ms(pid) else { continue };
        let at_beat = f64::from_bits(shared.cpu_ms.load(Ordering::Relaxed));
        let limit = f64::from_bits(shared.limit_ms.load(Ordering::Relaxed));
        let floor = f64::from_bits(shared.floor_ms.load(Ordering::Relaxed));
        let count = shared.beats.load(Ordering::Relaxed);
        if count != beats {
            beat_seen = Instant::now();
        }
        let lasted = floor == 0.0 || beat_seen.elapsed().as_secs_f64() * 1000.0 > floor;
        if limit > 0.0 && cpu - at_beat > limit && lasted {
            stop(pid);
            break Ended::Blocked;
        }
        if count != beats || cpu - beat_cpu > stuck_ms / 20.0 {
            beats = count;
            beat_at = Instant::now();
            beat_cpu = cpu;
        } else if beat_at.elapsed().as_secs_f64() * 1000.0 > stuck_ms {
            stop(pid);
            break Ended::Lost;
        }
    };
    PEAK.store(peak.to_bits(), Ordering::Relaxed);
    Ok(ended)
}

/// In a copy that runs a test file as a worker would, or one it made: its
/// event loop has turned.
#[napi]
pub fn turned() -> Result<()> {
    alive()?.turns.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Waits for a copy that runs a test file as a worker would. It watches
/// itself and the copies it makes, as a worker Vitest started does; what it
/// cannot see is itself stuck where no code of its own runs, on a lock
/// another thread held when it was made, which once kept a run waiting for
/// a night. So it is stopped when, for `stuck_ms`, it has no child, uses no
/// CPU time and neither it nor anything it copied turned an event loop. A copy
/// that waits for one it made has a child, and one that waits on the main
/// process turns its loop. Like `supervise` this does not run the event
/// loop, for the same reason. Returns the code the copy ended itself with,
/// -1 where it did not end by itself, or -2 where it was stopped.
#[napi]
pub fn host(pid: i32, stuck_ms: f64) -> Result<i32> {
    if pid <= 0 {
        return Err(Error::from_reason(format!("not a process id: {pid}")));
    }
    let shared = alive()?;
    let mut turns = shared.turns.load(Ordering::Relaxed);
    let mut cpu = cpu_ms(pid);
    let mut still_since = Instant::now();
    let mut checked = still_since;
    loop {
        let mut status = 0;
        // SAFETY: plain system call on a child of this process.
        let ended = unsafe { uninterrupted(|| libc::waitpid(pid, &mut status, libc::WNOHANG)) };
        if ended != 0 {
            return Ok(if ended == pid && libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 });
        }
        // The end of a copy is seen within milliseconds: a worker hands it
        // file after file, and slept a tenth of a second at a time it took
        // ufo's runs from 6.8 s to 10.7 s.
        std::thread::sleep(Duration::from_millis(2));
        if checked.elapsed() < Duration::from_millis(100) {
            continue;
        }
        checked = Instant::now();
        let still_ms = still_since.elapsed().as_secs_f64() * 1000.0;
        let now_turns = shared.turns.load(Ordering::Relaxed);
        let now_cpu = cpu_ms(pid);
        // Node's own threads use a little CPU time in a process that runs
        // nothing; a hundredth of the time it sat is not code of its running.
        let busy = matches!((now_cpu, cpu), (Some(now), Some(then)) if now - then > still_ms / 100.0);
        if now_turns != turns || busy || has_child(pid) {
            turns = now_turns;
            cpu = now_cpu;
            still_since = Instant::now();
        } else if still_ms > stuck_ms {
            stop(pid);
            return Ok(-2);
        }
    }
}

/// Whether a process has a child, one that has ended and not been waited for included.
#[cfg(target_os = "macos")]
fn has_child(pid: i32) -> bool {
    let mut children = [0 as libc::c_int; 16];
    // SAFETY: the kernel fills at most the buffer it is given.
    let count = unsafe { libc::proc_listchildpids(pid, children.as_mut_ptr().cast(), size_of_val(&children) as libc::c_int) };
    count > 0
}

#[cfg(not(target_os = "macos"))]
fn has_child(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) {
        Ok(children) => !children.trim().is_empty(),
        // A kernel without the file: what cannot be told keeps the copy.
        Err(_) => true,
    }
}

fn stop(pid: i32) {
    // SAFETY: plain system calls on a child of this process.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        uninterrupted(|| libc::waitpid(pid, ptr::null_mut(), 0));
    }
}

/// The kernel counts a process's time in units of its own; this is their length.
#[cfg(target_os = "macos")]
#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
}

/// Memory a process holds in RAM, in bytes.
#[cfg(target_os = "macos")]
fn resident_bytes(pid: i32) -> Option<f64> {
    // SAFETY: the kernel fills the structure, which is plain numbers.
    unsafe {
        let mut usage: libc::rusage_info_v2 = std::mem::zeroed();
        if libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, (&raw mut usage).cast()) != 0 {
            return None;
        }
        Some(usage.ri_resident_size as f64)
    }
}

#[cfg(not(target_os = "macos"))]
fn resident_bytes(pid: i32) -> Option<f64> {
    let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let pages: f64 = statm.split_ascii_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: plain system call.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as f64;
    Some(pages * page)
}

/// One region of a process's memory, as `proc_pidinfo` describes it
/// (`struct proc_regioninfo` of `<sys/proc_info.h>`).
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct RegionInfo {
    protection: u32,
    max_protection: u32,
    inheritance: u32,
    flags: u32,
    offset: u64,
    behavior: u32,
    user_wired_count: u32,
    user_tag: u32,
    pages_resident: u32,
    pages_shared_now_private: u32,
    pages_swapped_out: u32,
    pages_dirtied: u32,
    ref_count: u32,
    shadow_depth: u32,
    share_mode: u32,
    private_pages_resident: u32,
    shared_pages_resident: u32,
    obj_id: u32,
    depth: u32,
    address: u64,
    size: u64,
}

/// Memory a process holds that no other process shares, in bytes: what
/// the machine has to find for it. A copy shares with the process it was
/// copied from every page neither has written to since, which its resident
/// size counts in full. On macOS so does its footprint, once it has read a
/// page: a copy of a process holding 1 GiB read it all and its footprint
/// went from 4 MB to 1,030 MB, its private resident pages from 2 to 3 MB.
/// Those are counted region by region, 6,000 regions for a heap of 2 GB.
#[cfg(target_os = "macos")]
fn held_bytes(pid: i32) -> Option<f64> {
    const PROC_PIDREGIONINFO: libc::c_int = 7;
    let size = size_of::<RegionInfo>() as libc::c_int;
    // SAFETY: plain system call.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as f64;
    let mut address = 0u64;
    let mut pages = 0u64;
    let mut seen = false;
    loop {
        let mut region = RegionInfo::default();
        // SAFETY: the kernel fills at most `size` bytes of the structure, which is plain numbers.
        let got = unsafe { libc::proc_pidinfo(pid, PROC_PIDREGIONINFO, address, (&raw mut region).cast(), size) };
        if got != size {
            break;
        }
        seen = true;
        pages += u64::from(region.private_pages_resident);
        let next = region.address.saturating_add(region.size);
        if next <= address {
            break;
        }
        address = next;
    }
    seen.then(|| pages as f64 * page)
}

#[cfg(not(target_os = "macos"))]
fn held_bytes(pid: i32) -> Option<f64> {
    let rollup = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    let mut kilobytes = 0.0;
    for line in rollup.lines() {
        if let Some(rest) = line.strip_prefix("Private_Clean:").or_else(|| line.strip_prefix("Private_Dirty:")) {
            kilobytes += rest.trim().trim_end_matches("kB").trim().parse::<f64>().ok()?;
        }
    }
    Some(kilobytes * 1024.0)
}

/// Memory the machine can give processes without taking it from others,
/// in bytes: what Linux says is available, and on macOS the share of its
/// memory the system counts as free (`kern.memorystatus_level`, which
/// `memory_pressure` prints). The free and the inactive pages alone leave
/// out what macOS can compress or drop: on a 7 GB runner whose system said
/// two thirds to four fifths was free, copies waited for 2.3 GB for hours.
#[cfg(target_os = "macos")]
fn available_bytes() -> Option<f64> {
    fn read<T: Default>(name: &std::ffi::CStr) -> Option<T> {
        let mut value = T::default();
        let mut size = size_of::<T>();
        // SAFETY: the kernel writes at most `size` bytes into the value.
        let read = unsafe { libc::sysctlbyname(name.as_ptr(), (&raw mut value).cast(), &mut size, ptr::null_mut(), 0) };
        (read == 0 && size == size_of::<T>()).then_some(value)
    }
    let level: i32 = read(c"kern.memorystatus_level")?;
    let total: u64 = read(c"hw.memsize")?;
    Some(total as f64 * f64::from(level) / 100.0)
}

#[cfg(not(target_os = "macos"))]
fn available_bytes() -> Option<f64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find_map(|line| line.strip_prefix("MemAvailable:"))?;
    Some(line.trim().trim_end_matches("kB").trim().parse::<f64>().ok()? * 1024.0)
}

/// CPU time a process has used, in milliseconds.
#[cfg(target_os = "macos")]
fn cpu_ms(pid: i32) -> Option<f64> {
    let unit = nanoseconds_per_unit();
    // SAFETY: the kernel fills the structure, which is plain numbers.
    unsafe {
        let mut usage: libc::rusage_info_v2 = std::mem::zeroed();
        if libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, (&raw mut usage).cast()) != 0 {
            return None;
        }
        Some((usage.ri_user_time + usage.ri_system_time) as f64 * unit / 1e6)
    }
}

#[cfg(not(target_os = "macos"))]
fn cpu_ms(pid: i32) -> Option<f64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name, in parentheses, may hold spaces; the fields are counted from its end.
    let (_, rest) = stat.rsplit_once(')')?;
    let mut fields = rest.split_ascii_whitespace().skip(11);
    let user: f64 = fields.next()?.parse().ok()?;
    let system: f64 = fields.next()?.parse().ok()?;
    // SAFETY: plain system call.
    let per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    Some((user + system) * 1000.0 / per_second)
}

/// The time this process has spent on a processor and the time it has spent
/// ready to run and waiting for one, in milliseconds; none where the system
/// does not say. Over a stretch, their sum falls short of the time by the
/// clock by what the process spent asleep: waiting on a timer, a file, a
/// socket or a lock.
#[napi]
pub fn spent() -> Option<Vec<f64>> {
    spent_ms()
}

/// macOS keeps both for the whole process, its ended threads included. Its
/// runnable time counts the time running as well: a process spinning on a
/// quiet machine for 400 ms had 394 ms of it, and 1,655 ms of 1,663 by the
/// clock with every processor taken, 400 of them on one.
#[cfg(target_os = "macos")]
fn spent_ms() -> Option<Vec<f64>> {
    let unit = nanoseconds_per_unit();
    // SAFETY: the kernel fills the structure, which is plain numbers.
    unsafe {
        let mut usage: libc::rusage_info_v4 = std::mem::zeroed();
        if libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V4, (&raw mut usage).cast()) != 0 {
            return None;
        }
        let cpu = (usage.ri_user_time + usage.ri_system_time) as f64 * unit / 1e6;
        Some(vec![cpu, usage.ri_runnable_time as f64 * unit / 1e6 - cpu])
    }
}

/// Linux keeps the time waiting for a processor per thread, and this is the
/// process's first, which runs the test file's JavaScript: Vitest's forks
/// pool and the copies of its workers run it there. A kernel that keeps no
/// such statistics gives noughts, and a process that has run has waited for
/// a processor at some point.
#[cfg(not(target_os = "macos"))]
fn spent_ms() -> Option<Vec<f64>> {
    let stat = std::fs::read_to_string("/proc/self/schedstat").ok()?;
    let mut fields = stat.split_ascii_whitespace();
    let cpu: f64 = fields.next()?.parse().ok()?;
    let wait: f64 = fields.next()?.parse().ok()?;
    (cpu > 0.0 && wait > 0.0).then(|| vec![cpu / 1e6, wait / 1e6])
}

/// The length of the unit the kernel counts a process's time in, in nanoseconds.
#[cfg(target_os = "macos")]
fn nanoseconds_per_unit() -> f64 {
    static NANOSECONDS_PER_UNIT: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *NANOSECONDS_PER_UNIT.get_or_init(|| {
        let mut base = Timebase { numer: 1, denom: 1 };
        // SAFETY: the kernel fills the two numbers.
        unsafe { mach_timebase_info(&mut base) };
        f64::from(base.numer) / f64::from(base.denom)
    })
}

/// Ends the process at once. Node's own exit takes a copied process down
/// with an abort.
#[napi]
pub fn exit(code: i32) {
    // SAFETY: nothing of this process is used afterwards.
    unsafe { libc::_exit(code) }
}
