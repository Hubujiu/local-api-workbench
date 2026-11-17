# Bounded Apipost-style ajax callbacks

Source: https://wiki.apipost.cn/docs/sendrequest/ documents `$.ajax` callback
requests, JSON-string bodies, form data and callback-driven variables. It also
documents awaited calls, now supported through a bounded native Promise. This adapter is
implemented independently through our HTTP broker, not vendor code.

## Supported subset

- Object options: URL, method/type, headers, contentType/content-type, data,
  dataType (json/text), timeout, success/error/complete, async:true.
- GET/HEAD scalar data becomes encoded query parameters; existing query and
  fragment handling are preserved. Other methods accept strings or scalar form
  objects. False/zero/null retain meaningful encodings. JSON bodies must be
  explicitly serialized; objects with JSON content type are rejected.
- Success receives data, status text, and a small response facade. JSON is
  selected by dataType or response Content-Type; text override avoids parsing.
  Empty 204/HEAD and 304 have nocontent/notmodified outcomes.
- HTTP failure and invalid JSON go to error, then complete. Without an error
  callback they reject the returned Promise; success/error/complete callbacks may be async and are awaited in order. A handling error callback preserves the existing handled-failure contract and resolves undefined; an exception/rejection still fails. Completion runs after the selected callback and cannot mask its original failure, including undefined rejection. These are this implementation's explicit rules, not a claim of complete
  jQuery or original-runtime behavioral compatibility.
- Unknown settings, nested form values, script/JSONP data types, async:false,
  jqXHR done/fail methods and arbitrary browser APIs are not
  supported. Unsupported options fail before dispatch.

The same network permission, 10-total/4-active request limits, 64KiB request and
256KiB response bounds, 1500ms child timeout, 2-second total deadline and QuickJS
isolation apply. No external requests or credentials are needed by the tests.
All network regression fixtures bind only to loopback.

This fills the callback API gap, not full SDK or Promise compatibility.


Awaiting $.ajax resolves parsed success data only after completion settles. Native then/catch are available, but this is not a jqXHR facade. Unawaited rejections are still tracked by the VM. All callbacks, returned Promise jobs, HTTP, timers and output remain inside the existing shared resource envelope. Red-first tests verify awaiting data, caught HTTP errors, async callback order, original-error preservation, undefined rejection and unfinished completion. The real-browser shared-script scenario awaits ajax before the main request and checks completion evidence.
