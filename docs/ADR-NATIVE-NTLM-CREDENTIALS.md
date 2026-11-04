# Canonical native NTLM credential definitions

Status: contract only; implementation and runtime acceptance pending.

## Source evidence and limited meaning

Legally acquired Apipost 2.0.0 static send-index.js SHA256 is
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`.
Zero-based Unicode character offsets: operational NTLM defaults at 9948640;
shared native-to-send field conversion at 33608834; NTLM handler at 27867404;
retry-disable gate at 27871863; username/domain fallback parser at 27868393.
No original application or proprietary handler is executed or copied.

Native NTLM starts unauthenticated, permits 401/403 negotiation and has a
retry-disable flag. Workbench already uses explicit-credential, preemptive Type1,
401-only, same-socket bounded NTLMv2. This adapter converts credential definitions
for that existing Workbench executor. It does not claim original wire equivalence,
three-leg bootstrap, 403 support, NTLMv1/LM fallback, integrated OS identity or
new MIC/EPA/proxy/HTTP2 compatibility. No signer or transport change is required.

## Definition contract

The native selected section permits only username, password, domain, workstation
and disableRetryRequest. Fields must be enumerable own data properties on a
plain/null-prototype object. Reject unknown, hidden, symbolic, accessor and
present-undefined fields without invoking getters or toJSON. The outer envelope
may keep unrelated inactive auth sections; only the selected descriptors matter.

Username must be a nonempty string. Missing password/domain/workstation become
empty strings, matching existing explicit credential defaults; present values
must be strings. Preserve permitted credential templates without evaluating them.
Missing disableRetryRequest means false; only literal false is accepted when
present. True, numeric legacy switches and templated/string flags cannot be
silently converted to the existing always-negotiating Workbench executor.

Original native identity handling may split DOMAIN\\USER or USER@DOMAIN when
domain resolves empty. Workbench treats username and domain as separate fields.
To avoid silently changing those definitions, a username containing either
separator or a template is accepted only with a nonempty literal domain that
cannot resolve through templates. With an empty or templated domain, require a
literal separator-free username. Do not guess or pre-render identities. This
conservative restriction is a documented migration gap; full project backup is
still available. The UI default's `entity` alias is not guessed as `domain`.

Canonical Workbench auth has exactly type=ntlm, username, password, domain and
workstation. Export accepts only these fields with the same conservative identity
check and emits all four strings plus disableRetryRequest=false. Import/export
canonical inversion is deep-equal, not original omitted-field preservation.
Both source selected section and canonical native output are capped at 64 KiB
UTF-8 JSON bytes after safe descriptor/type validation; defaults count toward the
output cap. Existing runtime credential lengths/characters remain enforced at
execution after interpolation; conversion never obtains credentials or signs.

## Acceptance and safety

- Pure complete field/default/type/descriptor/unknown/identity/template/size
  matrix, canonical inverse, no input mutation, fixed redacted errors.
- Both native JSON and directory formats through owner import/export/reimport,
  frozen plans, backup/restore/reopen and actual SDK/CLI execution with explicit
  imported environment selection. An independent NTLMv2 proof oracle verifies
  actual Type1/Type3, identity, exact body and same-socket exchange.
- Unsupported definitions reject atomically without partial artifacts, source
  mutation or peer traffic. No real account, OS credential cache or secret is used.
- Integrated project/folder/own/noauth inheritance remains a separate root gate;
  existing OpenAPI unsupported-auth rejection stays atomic and redacted.
- Feature and integrated ordinary CI plus current portable byte proofs determine
  acceptance. Local static/syntax/format checks are not runtime passes. Preserve
  all prior failure/cancellation evidence; no budget or security relaxation.
