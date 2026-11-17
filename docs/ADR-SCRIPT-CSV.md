# Bounded CSV response utility

The official apt documentation lists csv2array(apt.response.text()): https://v7-wiki.apipost.cn/docs/1314/ . The separately published upstream package API also has options (https://github.com/olalonde/csv2array); those options are not claimed here. No upstream parser code or package is copied into this implementation.

Expose csv2array(text) within the existing isolated VM. It returns string rows, retaining the first row rather than interpreting it as variable names. A shared independently implemented state-machine parser handles commas, CR/LF/CRLF, quoted commas/newlines, doubled quotes, BOM and trailing empty cells. No scalar coercion, spreadsheet formula execution, file reads, network, regex-generated parsing or header-object conversion. Malformed quoting and extra arguments fail explicitly.

Script inputs are limited to 64 KiB UTF-8, 1000 rows and 100 columns per call. Repeated calls still share existing VM memory, 250ms active budget, 2s deadline and aggregate output limit. This is a bounded subset, not full library equivalence.

The load-test adapter reuses the pure parser but retains its original 100 data rows plus header, 50 columns, valid unique header names and rectangular-data checks. Empty/whitespace handling remains unchanged. CSV response scripts do not write load datasets or project variables unless the script explicitly requests a write. Tests cover actual script response input, quoted/multiline data, literal formula/prototype-like cells, malformed syntax, explicit budget errors, and existing load tests; packaged desktop and browser regressions exercise the utility too.
