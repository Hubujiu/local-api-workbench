# Bounded one-argument script Mock templates

## Scope and evidence

This is a work-in-progress script SDK subset, not a project Mock server mode or
complete Mock.js compatibility. Original Offline2 send-index SHA256
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`
statically exposes Mock from sandbox mockjs before enabled custom scripts enter
script.exec. Its one-argument mock enters Handler.gen. There is no original
runtime fixture here. Its project Mock server instead uses json-schema-faker
for schema responses and JSON5.parse/raw for raw responses.

Adapt the admitted-path algorithms from published MIT apipost-mock1.0.2, with
no runtime dependencies, already in develop. Dist SHA256 is
`444c7ccad3c4ee00ce6871517995852d5a5928715a6b449d3f2622291e6e816a`.
The dedicated builder pins this source, seven inclusive source spans and both
retained notices, checks the exact three-input esbuild graph (entry, modified
core, facade), and emits source hashes and an integrity manifest. Attribution
and exact span hashes are in `scripts/script-mock-source.json`. This is a
modified semantic adaptation, not a byte-identical extracted module. No extracted
proprietary wrapper is distributed and no old wrapper/Faker chain is installed.
The old native Random bundle, manifest and adapter are unchanged.

Keep APIPOST-MOCK-LICENSE.txt (Apipost2022) and MOCKJS-UPSTREAM-LICENSE.txt
(nuysoft2015), the latter from upstream fixed commit
15a269dc1896a506cd5052743ad1027d79a23bc5, LICENSE Git blob
41ccca605406a8ea23c047cf367e75822fb86f69. Both are MIT. Identical internal
1.0.1-beta3 labels do not prove complete equivalence: original placeholder
regexp permits slash/dot while the published package excludes them, and
multiargument registration behavior differs. Only the admitted numeric/array
handlers were statically compared; original-runtime random equivalence is not
claimed. CI-only differential cases compare the admitted subset to the locked
public distribution, including a deterministic draw stream and draw count.

## Contract

`Mock` is a non-replaceable frozen facade exposing only `mock(template)` with
exactly one argument. No raw Random/Handler/Util/RE/XHR, module alias, arbitrary
require, URL registration or media generation is exposed.

Admit ordinary JSON data trees: null, booleans, finite numbers, strings, plain
objects (including null prototype) and dense arrays. Reject functions, getters,
hidden/symbol properties, exotic/custom prototypes, sparse arrays, undefined,
nonfinite numbers, cycles and shared object aliases. Inspect own data
descriptors rather than invoking getters or toJSON; return fresh containers
and leave the input unchanged. Proxy traps may run during JS reflection and
cannot reliably be identified side-effect-free in the same realm. This is a
JSON-data contract, not a promise to prevent arbitrary already-executable
script Proxy code from running. No proxy/input object reaches the generator:
only a freshly owned descriptor-checked clone does.

Every value string containing `@` is rejected, including escaped/unknown
placeholders and email-looking literals. The original core evals placeholder
parameters before looking up the name; unknown-name fallback is not safe.
Aliases, recursive references and placeholder arguments are not supported.

Only complete numeric/array `key|n` and `key|min-max` rules are admitted.
Canonical decimal integer bounds and their span must be safe integers, range
ordered; array counts0–1000. Reject increments, decimals, string/boolean/object
rules, malformed suffixes and projected duplicate keys. Reject constructor,
prototype and __proto__ before and after projection. Rule base names exclude
control/newline/Unicode line separators to avoid upstream partial-regex parsing.

Preserve core semantics: nonempty array|1 returns one selected element;
array|1-1 returns an array; other counts repeat the entire template sequence;
empty arrays stay empty. Selection generates ALL candidates before picking.
Numeric generation retains the core Math.round distribution, not a substituted
uniform floor. An explicit equal-bound range still draws before dispatch; even
an empty ranged array consumes that parser draw. A single-count rule does not
draw its count; `|1` draws its pick after all candidates, including a one-item
array. No seed/replay/cryptographic-random promise. Increments and
aliases that would mutate templates are deliberately rejected.

## Resource and integrity envelope

Input/output each64KiB exact JSON UTF-8, depth32, input/expanded work each1000
nodes. Count punctuation, escaping, surrogate pairs and lone surrogates. Before
generation, preflight the maximum full nested expansion and discarded selection
candidates with overflow-safe capped arithmetic. Descriptor validation and
bounded input cloning happen before expanded allocation, not before every
reflection allocation in the already bounded guest heap.

Each existing PRE or POST phase additionally shares at most1000attempts,
10000generated-work nodes and1MiB generated-work bytes across all scopes.
The private host bridge grants accounting only, not network/database authority.
Attempt debit occurs before arity, guard or validation; failed caught attempts
are charged. Work is reserved before core execution. Exhaustion is sticky and
saturates trusted counters, so a later fresh scope cannot refill a caught limit.
These counters are consumed reservation credits, not observed execution counts;
terminal saturation does not claim the rejected generation actually ran.
Parent validates integral counters against supplied bounds before publishing
and subtracts them for subsequent scopes. PRE and POST remain separate phases
under the existing phase contract. Independent future runs start fresh.
No-Mock error diagnostics keep the preexisting exact shape. Relevant attempted
Mock calls or exhausted zero-credit calls include the trusted Mock counters;
success usage always includes all three counters for parent-side accounting.

A final primitive-only checkpoint checks the existing host activity deadline
after result validation, before returning the Mock value. It does not debit or
replenish credits. The ordinary error is catchable by script code: this closes
the helper's late-value publication gap, not a promise of globally atomic
termination or rollback of unrelated script HTTP/database side effects.

The core executes in the EXISTING script QuickJS, with unchanged250ms active
time,2s wall,16MiB heap,512KiB stack,1MiB final output and all existing quotas.
No second Mock VM or additional bootstrap budget. Eager installation of the
small admitted-path adaptation means EVERY script pays load/hash/compile/
initialization, even without a Mock
call. Read/hash elapsed time is charged into compatibility activity; compile
and install occur after the activity deadline starts. Each fresh scope pays
again against the shared remaining budget. Runtime CI must establish whether
this fits; failures require redesign, not increased budgets or soft skips.

Core and adapter are enclosed with captured lexical intrinsic globals before
user functions/scripts. The modified private core uses captured direct native
calls, own-key loops and defineProperty writes, not ambient prototype methods,
for-in, implicit iterators or `.call`. Unsupported placeholder/eval, RegExp,
Random catalogue/media/require and context/reference branches are physically
absent from the new asset; the old Random asset is untouched.

An explicit surface guard checks the named captured global descriptors, their
native objects, Object/Array/String/RegExp/Function/Number/Boolean/WeakSet/Error
prototypes, directly captured callable objects, Math.random/round and the
Object.prototype.toString own-call anchor. Each surface includes its complete
own-key order, descriptors and prototype. Checks occur before validation and
after traversal immediately before generation, covering the existing inherited
payload, method replacement and Proxy mutation cases. This is no longer a
recursive graph of every unrelated intrinsic; direct captured-call semantics
provide the core's safety boundary. Changes to arbitrary unused nested builtin
function properties are not claimed to be universally detected. No globals are
temporarily restored or frozen. Native descriptors are read only by their own
data/accessor kind; cloning and result-write descriptors have null prototypes.
Core references never leave the private closure.

## Verification state

Local scope permits static checks and independently reviewed builtin-only
adapter/ledger tests with inert generators. No local app, Mock, VM, Worker,
SQLite or original-runtime execution is authorized. Dedicated asset generation
requires separate executable/dependency source audit first. Runtime tests are
authored for ordinary exact-commit CI and remain unrun until that evidence exists.

Acceptance requires actual PRE→HTTP→POST→next HTTP, variable/result/history/save
evidence, frozen definitions, backup/new Store/restart, project/environment/run
isolation, PRE zero-network failures and POST retention of real HTTP evidence.
Reject unsafe input/overloads/prototype and projection collisions before core;
prove cumulative failed-call accounting and all-candidate array work, byte/node
limits and fresh-run recovery. Preserve all old tests and require cross-platform
asset/notice integrity plus final fresh packaged bytes. No frontend or visual
work, overall delivery, original-runtime parity, merge or deployment claim.

### Local static checkpoint (2026-11-01)

Independent source review found no unresolved safety blocker in the bounded
facade/ledger. The first reviewed adapter set passed8 builtin-only tests; the
final checkpoint increment passed9 adapter/ledger tests plus2 actual-file
artifact/source checks and6 preserved bootstrap pure checks (17/17). Generators
in the pure tests are inert stubs, not the public Mock implementation.

The dedicated builder and exact installed package/esbuild/platform binary were
independently checked against real registry tarballs and lock integrity before
static generation. Actual generated bundle182743bytes, SHA256
`f489fcf16ee9f1fbea348b1ef6d3c227ef86c05a0cf33b2dce294e3a178330f3`,
was independently read back with its manifest/exact input graph and notices;
old native Random JS/JSON remain unchanged. No generated bundle or product
runtime was executed locally. Syntax/formatting/static-byte evidence does not
prove QuickJS semantic behavior, load cost or end-to-end runtime acceptance;
the authored real runtime/workflow tests required ordinary exact-head CI.

### First ordinary CI and redesign (2026-11-02)

PR #82 run `41424728494`, attempt 1, exact head
`9438514e01ad677c963a2fd3dd6e6a6d9a2f5a9e`, failed 3 of 10 jobs. All three new
HTTP/persistence workflows passed on Linux, macOS and Windows, but repeated Mock
cases exceeded activity time and existing no-Mock shared-scope workflows also
regressed. Full-core eager installation and recursive graph setup consumed the
remaining phase budget even with zero Mock calls. This candidate was rejected;
no limits, concurrency, old assertions or negative cases were relaxed.

The redesign replaces the full package asset with the attributed narrow core
above and explicit captured-native surfaces. Differential public-package tests
are ordinary-CI-only, never part of local inert-generator pure checks. The first
red evidence remains preserved; the redesigned candidate requires a new exact-
head ordinary CI before any runtime or performance acceptance claim.
