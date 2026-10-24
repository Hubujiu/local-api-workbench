# Primitive Faker bridge and bounded failure diagnostics

The existing fixed English-locale catalogue returns only string/number/boolean
values (dates are normalized to ISO text), or undefined for an unknown name.
The worker previously JSON-stringified each value into a VM string and the VM
parsed it again. Return primitive QuickJS handles directly instead. No host
object, provider instance, module path, callback argument or new capability is
exposed. Catalogue selection, output bounds, lazy English locale loading and
per-sequence Faker counting remain unchanged, including counting a rejected
attempt after the configured remaining allowance is exhausted.

Failure outcomes now carry only numeric budget/counter diagnostics:
activityBudgetMs, fakerCalls, timerCount and requestCount. They contain no input
script, variable value, generated value or credential. Preserve the original
error message and script stage, and pass these diagnostics through the parent
worker boundary. Diagnostics do not authorize retry or turn an error into success.

A Windows quota-boundary run observed a time-expiry error before the expected
Faker-count error. That observation alone does not establish a unique cause or
show the quota was reset. Removing redundant serialization is an independent
bounded overhead reduction, not proof that all scheduling-related timeouts are
fixed. Keep the original 250ms activity/2s wall limits, 1000-call aggregate quota,
and unchanged sequence quota assertion. Focused repeated local measurements are
not a replacement for exact-head cross-platform CI.

Fixed tests compare primitive types for every advertised catalogue name, retain
unknown-module/name rejection, check bounded failure counters, and exercise the
original two-stage quota test unchanged. No production dependency is changed.
