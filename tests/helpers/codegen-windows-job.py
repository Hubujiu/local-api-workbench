"""Test-only Windows Job Object owner. No generated source is logged."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import msvcrt

kernel = c.WinDLL("kernel32", use_last_error=True)
HANDLE = w.HANDLE
SIZE_T = c.c_size_t
ULONG_PTR = c.c_size_t


class BasicLimits(c.Structure):
    _fields_ = [("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64),
                ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", SIZE_T),
                ("MaximumWorkingSetSize", SIZE_T), ("ActiveProcessLimit", w.DWORD),
                ("Affinity", ULONG_PTR), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class IO(c.Structure):
    _fields_ = [(name, c.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class ExtendedLimits(c.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IO),
                ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T),
                ("PeakProcessMemoryUsed", SIZE_T), ("PeakJobMemoryUsed", SIZE_T)]


class Accounting(c.Structure):
    _fields_ = [(name, c.c_int64) for name in ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [(name, w.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]


class Startup(c.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", c.POINTER(c.c_byte)), ("hStdInput", HANDLE), ("hStdOutput", HANDLE), ("hStdError", HANDLE)]


class StartupEx(c.Structure):
    _fields_ = [("StartupInfo", Startup), ("lpAttributeList", c.c_void_p)]


class Process(c.Structure):
    _fields_ = [("hProcess", HANDLE), ("hThread", HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


def bind(name, args, result=w.BOOL):
    fn = getattr(kernel, name)
    fn.argtypes, fn.restype = args, result
    return fn


create_job = bind("CreateJobObjectW", [c.c_void_p, w.LPCWSTR], HANDLE)
set_job = bind("SetInformationJobObject", [HANDLE, c.c_int, c.c_void_p, w.DWORD])
query_job = bind("QueryInformationJobObject", [HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p])
initialize_attributes = bind("InitializeProcThreadAttributeList", [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(SIZE_T)])
update_attribute = bind("UpdateProcThreadAttribute", [c.c_void_p, w.DWORD, ULONG_PTR, c.c_void_p, SIZE_T, c.c_void_p, c.c_void_p])
delete_attributes = bind("DeleteProcThreadAttributeList", [c.c_void_p], None)
terminate_job = bind("TerminateJobObject", [HANDLE, w.UINT])
create_process = bind("CreateProcessW", [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.c_void_p, c.POINTER(Process)])
resume = bind("ResumeThread", [HANDLE], w.DWORD)
wait = bind("WaitForSingleObject", [HANDLE, w.DWORD], w.DWORD)
exit_code = bind("GetExitCodeProcess", [HANDLE, c.POINTER(w.DWORD)])
terminate_process = bind("TerminateProcess", [HANDLE, w.UINT])
close = bind("CloseHandle", [HANDLE])
set_inherit = bind("SetHandleInformation", [HANDLE, w.DWORD, w.DWORD])
get_standard = bind("GetStdHandle", [w.DWORD], HANDLE)

def wait_job_cleanup(query_active, wait_parent, deadline, receipt, monotonic, pause):
    """Require both OS receipts inside one existing cleanup deadline."""
    while monotonic() < deadline:
        receipt["jobActiveProcesses"] = query_active()
        status, error = wait_parent()
        receipt["finalWaitStatus"] = status
        receipt["finalWaitError"] = error if status == 0xffffffff else None
        receipt["childClosed"] = status == 0
        if status not in (0, 258):
            return False
        if receipt["jobActiveProcesses"] == 0 and status == 0:
            return monotonic() < deadline
        remaining = deadline - monotonic()
        if remaining <= 0:
            return False
        pause(min(0.02, remaining))
    return False


job = None
process = Process()
null_fd = None
attributes = None
attributes_initialized = False
resumed = False
stage = "admission"
result = {"exitCode": None, "childClosed": False, "cleanupConfirmed": False, "admissionFailed": False, "stage": None, "jobActiveProcesses": None, "finalWaitStatus": None, "finalWaitError": None, "terminateJobAccepted": None, "stopObserved": None}
try:
    config = json.loads(sys.stdin.readline())
    binary = shutil.which(config["binary"])
    if not binary:
        raise RuntimeError()
    stopped = threading.Event()
    def read_stop():
        sys.stdin.readline()
        stopped.set()
    threading.Thread(target=read_stop, daemon=True).start()
    stage = "job-create"
    job = create_job(None, None)
    if not job:
        raise RuntimeError()
    stage = "job-configure"
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
    if not set_job(job, 9, c.byref(limits), c.sizeof(limits)):
        raise RuntimeError()
    stage = "job-attributes"
    null_fd = os.open(os.devnull, os.O_RDWR)
    os.set_inheritable(null_fd, True)
    null_handle = msvcrt.get_osfhandle(null_fd)
    size = SIZE_T()
    initialize_attributes(None, 2, 0, c.byref(size))
    attributes = c.create_string_buffer(size.value)
    if not initialize_attributes(attributes, 2, 0, c.byref(size)):
        raise RuntimeError()
    attributes_initialized = True
    jobs = (HANDLE * 1)(job)
    handles = (HANDLE * 1)(null_handle)
    # JOB_LIST admits the suspended process atomically. If assignment fails,
    # CreateProcess fails without leaving an unowned suspended process behind.
    if not update_attribute(attributes, 0, 0x2000D, jobs, c.sizeof(jobs), None, None):
        raise RuntimeError()
    # Explicit handle allowlist excludes receipt/control pipes and the job handle.
    if not update_attribute(attributes, 0, 0x20002, handles, c.sizeof(handles), None, None):
        raise RuntimeError()
    startup = StartupEx()
    startup.StartupInfo.cb = c.sizeof(startup)
    startup.StartupInfo.dwFlags = 0x100
    startup.StartupInfo.hStdInput = startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = null_handle
    startup.lpAttributeList = c.cast(attributes, c.c_void_p)
    command = c.create_unicode_buffer(subprocess.list2cmdline([binary] + config["args"]))
    stage = "atomic-job-admission"
    if not create_process(binary, command, None, None, True, 0x4 | 0x08000000 | 0x80000, None, None, c.byref(startup), c.byref(process)):
        raise RuntimeError()
    if not stopped.is_set():
        stage = "resume"
        if resume(process.hThread) == 0xffffffff:
            raise RuntimeError()
        resumed = True
    stage = "execute"
    while not stopped.is_set():
        status = wait(process.hProcess, 20)
        if status == 0:
            code = w.DWORD()
            if not exit_code(process.hProcess, c.byref(code)):
                raise RuntimeError()
            result["exitCode"] = code.value
            break
        if status != 258:
            raise RuntimeError()
    # Parent exit alone is insufficient: kill any remaining job members, then
    # demand the OS job's zero-active-process receipt before reporting cleanup.
    stage = "job-terminate"
    result["stopObserved"] = stopped.is_set()
    result["terminateJobAccepted"] = bool(terminate_job(job, 1))
    if not result["terminateJobAccepted"]:
        raise RuntimeError()
    stage = "job-cleanup-receipt"
    deadline = time.monotonic() + 2
    def query_active():
        accounting = Accounting()
        if not query_job(job, 1, c.byref(accounting), c.sizeof(accounting), None):
            raise RuntimeError()
        return accounting.ActiveProcesses
    def wait_parent():
        status = wait(process.hProcess, 0)
        return status, c.get_last_error() if status == 0xffffffff else None
    result["cleanupConfirmed"] = wait_job_cleanup(
        query_active, wait_parent, deadline, result, time.monotonic, time.sleep)
    if not result["cleanupConfirmed"]:
        raise RuntimeError()

except BaseException:
    result["admissionFailed"] = not resumed
    result["stage"] = stage
finally:
    # All successfully created processes are already owned by the job.
    # Closing its last handle also kills members if any exceptional path failed.
    if attributes_initialized:
        delete_attributes(attributes)
    if job:
        close(job)
    if process.hThread:
        close(process.hThread)
    if process.hProcess:
        close(process.hProcess)
    if null_fd is not None:
        os.close(null_fd)
print(json.dumps(result), flush=True)

os._exit(0)  # Avoid interpreter shutdown waiting on the daemon control reader.
