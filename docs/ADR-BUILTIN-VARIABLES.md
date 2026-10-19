# Common builtin request variables

Reference: https://wiki.apipost.cn/docs/value/fakerjs/ documents dollar-prefixed
request variables and explicit script replaceIn calls. This is an independent,
bounded subset, not the full Faker dataset or a matching random distribution.

Supported names: $guid, $randomUUID, $timestamp, $isoTimestamp,
$randomAlphaNumeric, $randomBoolean, $randomInt, $randomHexColor, $randomIP,
$randomIPV6, $randomMACAddress, $randomPassword, $randomProtocol, $randomSemver,
$randomColor, $randomAbbreviation.

Use double-brace placeholders in URL/header/body/form fields. Each occurrence
generates a new value unless an explicitly defined variable of the same name
exists; explicit variables win. Integers range0..1000, UUIDs use version4 bits,
and timestamps use current UTC time. Values are interpolated as strings; users
choose quoted or unquoted JSON contexts. For arbitrary typed/escaped values,
use the existing structured Body dynamic-value editor.

The same pure generator factory runs inside QuickJS through its existing bounded
random-byte bridge. pm.variables.replaceIn and apt.variables.replaceIn resolve
current local/environment/global/runtime scopes. Unknown names still fail.
Script source is preserved until execution rather than substituted while
building the request; post-scripts can therefore resolve freshly extracted
variables. This also avoids injecting a variable value into JavaScript source.

Script replaceIn is limited to64KiB UTF-8 input/output and1000 substitutions.
No network/filesystem or module-loading capability is added. Generated values,
including the password-shaped sample, are test data, not provisioned credentials.
Full Faker locale/name/address catalogs remain unimplemented.
