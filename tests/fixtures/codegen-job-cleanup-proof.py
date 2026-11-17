"""Execute only the portable cleanup function's actual AST, with fake WinAPI."""
import ast
from pathlib import Path
import sys

module = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "wait_job_cleanup"]
assert len(functions) == 1
namespace = {}
exec(compile(ast.Module(body=functions, type_ignores=[]), "actual-cleanup-function", "exec"), namespace)
cleanup = namespace["wait_job_cleanup"]


def scenario(active, statuses, expected, expected_waits=None):
    now = [0.0]
    calls = [0, 0]
    receipt = {"childClosed": False}
    def query():
        index = min(calls[0], len(active)-1)
        calls[0] += 1
        return active[index]
    def wait():
        index = min(calls[1], len(statuses)-1)
        calls[1] += 1
        status = statuses[index]
        return status, 5 if status == 0xffffffff else None
    def pause(duration):
        now[0] += duration
    result = cleanup(query, wait, 2.0, receipt, lambda: now[0], pause)
    assert result is expected, receipt
    assert now[0] <= 2.0, now
    if expected_waits is not None:
        assert calls[1] == expected_waits, calls
    return receipt


# Job count becomes zero before the process handle is signaled.
receipt = scenario([0], [258, 0], True, 2)
assert receipt["childClosed"] is True and receipt["jobActiveProcesses"] == 0
# Opposite order must also require both receipts.
scenario([1, 0], [0], True, 2)
receipt = scenario([0], [0xffffffff], False, 1)
assert receipt["finalWaitError"] == 5 and receipt["childClosed"] is False
receipt = scenario([0], [258], False)
assert receipt["finalWaitStatus"] == 258
receipt = scenario([1], [0], False)
assert receipt["childClosed"] is True and receipt["jobActiveProcesses"] == 1
# Unknown statuses cannot silently become success.
scenario([0], [128], False, 1)
# No grace period is invented after an already expired deadline.
assert cleanup(lambda: 0, lambda: (0, None), 0, {}, lambda: 0, lambda _: None) is False
print("actual cleanup AST: job-first, handle-first, WAIT_FAILED, both deadline failures, unknown status, expired deadline passed")
