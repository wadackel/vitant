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

/// Copies this process. Returns 0 in the copy, whose event loop is rebuilt,
/// and the copy's process id in the process that was copied.
///
/// `lock` is a file descriptor to hold a lock on for the time of the call: the
/// kernel makes copies one at a time, and processes that all try at once
/// spend their time waiting on one another inside it.
#[napi]
pub fn fork(lock: i32) -> Result<i32> {
    let shared = beat()?;
    // Mapped before the copy is made, so that the two share it.
    alive()?;
    // No copy exists that could be writing: the one before was waited for.
    shared.clear();
    // SAFETY: plain system calls on a descriptor the caller owns.
    unsafe { uninterrupted(|| libc::flock(lock, libc::LOCK_EX)) };
    #[cfg(target_os = "linux")]
    if let Err(error) = inherit_everything() {
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
        libc::flock(lock, libc::LOCK_UN);
        match failure {
            Some(error) => Err(error),
            None => Ok(pid),
        }
    }
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
    /// Stopped for using more CPU time than it may without a heartbeat, or
    /// for holding more memory than it may: it blocks, or it would take the
    /// machine with it, either of which is a verdict.
    Blocked,
    /// Without a verdict. It ended on its own, as it does once it is over
    /// its time by the clock; or it sat without using CPU time or returning
    /// to its event loop, as one waiting for a thread it does not have
    /// would, and was stopped.
    Lost,
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
    loop {
        let mut status = 0;
        // SAFETY: plain system call on a child of this process.
        let ended = unsafe { uninterrupted(|| libc::waitpid(pid, &mut status, libc::WNOHANG)) };
        if ended != 0 {
            // Either the copy, or an error saying it is no child of this
            // process any more; it wrote its verdict or it did not.
            let wrote = shared.done.load(Ordering::Relaxed) == 1;
            return Ok(if ended == pid && wrote { Ended::Done } else { Ended::Lost });
        }
        std::thread::sleep(Duration::from_millis(2));
        if checked.elapsed() < Duration::from_millis(20) {
            continue;
        }
        checked = Instant::now();
        // A copy can take a gigabyte a second, and as many copies as there
        // are workers do so at once when mutants next to each other in the
        // source all do: the limits on time come after the machine is out
        // of memory.
        if resident_limit > 0.0 && resident_bytes(pid).is_some_and(|held| held > resident_limit) {
            stop(pid);
            return Ok(Ended::Blocked);
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
            return Ok(Ended::Blocked);
        }
        if count != beats || cpu - beat_cpu > stuck_ms / 20.0 {
            beats = count;
            beat_at = Instant::now();
            beat_cpu = cpu;
        } else if beat_at.elapsed().as_secs_f64() * 1000.0 > stuck_ms {
            stop(pid);
            return Ok(Ended::Lost);
        }
    }
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

/// CPU time a process has used, in milliseconds.
#[cfg(target_os = "macos")]
fn cpu_ms(pid: i32) -> Option<f64> {
    static NANOSECONDS_PER_UNIT: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    let unit = *NANOSECONDS_PER_UNIT.get_or_init(|| {
        let mut base = Timebase { numer: 1, denom: 1 };
        // SAFETY: the kernel fills the two numbers.
        unsafe { mach_timebase_info(&mut base) };
        f64::from(base.numer) / f64::from(base.denom)
    });
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

/// Ends the process at once. Node's own exit takes a copied process down
/// with an abort.
#[napi]
pub fn exit(code: i32) {
    // SAFETY: nothing of this process is used afterwards.
    unsafe { libc::_exit(code) }
}
