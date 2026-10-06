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
    beats: AtomicU64,
    /// 1 once the copy has written its verdict.
    done: AtomicU64,
}

impl Beat {
    fn clear(&self) {
        self.cpu_ms.store(0f64.to_bits(), Ordering::Relaxed);
        self.limit_ms.store(0f64.to_bits(), Ordering::Relaxed);
        self.beats.store(0, Ordering::Relaxed);
        self.done.store(0, Ordering::Relaxed);
    }
}

static BEAT: AtomicPtr<Beat> = AtomicPtr::new(ptr::null_mut());

/// The shared page, mapped on first use.
fn beat() -> Result<&'static Beat> {
    let known = BEAT.load(Ordering::Acquire);
    if !known.is_null() {
        // SAFETY: set below to a mapping that is never unmapped.
        return Ok(unsafe { &*known });
    }
    // SAFETY: an anonymous mapping of one `Beat`, which is integers and
    // valid when zeroed, as fresh pages are.
    let mapped = unsafe {
        libc::mmap(
            ptr::null_mut(),
            size_of::<Beat>(),
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANON,
            -1,
            0,
        )
    };
    if mapped == libc::MAP_FAILED {
        return Err(os_error("mmap"));
    }
    BEAT.store(mapped.cast(), Ordering::Release);
    // SAFETY: as above.
    Ok(unsafe { &*mapped.cast::<Beat>() })
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

/// In a copy: its CPU time so far and how much more it may use before it
/// says so again.
#[napi]
pub fn heartbeat(cpu_ms: f64, limit_ms: f64) -> Result<()> {
    let shared = beat()?;
    shared.cpu_ms.store(cpu_ms.to_bits(), Ordering::Relaxed);
    shared.limit_ms.store(limit_ms.to_bits(), Ordering::Relaxed);
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
    /// Without a verdict. It ended on its own; or it sat without using CPU
    /// time or returning to its event loop, as one waiting for a thread it
    /// does not have would; or it went on past `ceiling_ms`. The last two
    /// were stopped.
    Lost,
}

/// Waits for a copy to end, without running this process's event loop: a
/// message on a channel both share has to reach the copy. The copy has no
/// thread to watch it, so the watching is done here.
#[napi]
pub fn supervise(pid: i32, stuck_ms: f64, ceiling_ms: f64) -> Result<Ended> {
    // Zero and below name groups of processes to `waitpid` and `kill`.
    if pid <= 0 {
        return Err(Error::from_reason(format!("not a process id: {pid}")));
    }
    let shared = beat()?;
    let started = Instant::now();
    let mut beats = 0;
    let mut beat_at = started;
    let mut beat_cpu = 0.0;
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
        if started.elapsed().as_secs_f64() * 1000.0 > ceiling_ms {
            stop(pid);
            return Ok(Ended::Lost);
        }
        // Without its CPU time the copy cannot be judged; the ceiling ends it.
        let Some(cpu) = cpu_ms(pid) else { continue };
        let at_beat = f64::from_bits(shared.cpu_ms.load(Ordering::Relaxed));
        let limit = f64::from_bits(shared.limit_ms.load(Ordering::Relaxed));
        let count = shared.beats.load(Ordering::Relaxed);
        if limit > 0.0 && cpu - at_beat > limit {
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
