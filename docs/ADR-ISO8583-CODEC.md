# Explicit-profile ISO8583 codec and real TCP roundtrip

REA's selected original TCP module exposes fixed/delimited/ISO8583 modes. The old iso_8583 2.6.7 ISC candidate was evaluated in a separate research workspace; its jxon → xmldom path has a critical audit finding and is not installed in the product. Do not suppress that advisory or call the old dependency safe merely because a particular method does not use XML.

This implementation reuses @tikpay/iso8583-ts 0.4.0 (MIT, no runtime dependencies), with a narrow validated adapter. It is not a full Apipost/native-profile migration or a financial transaction engine. The library is a newer alternative, not evidence by itself of production equivalence. Requests must supply a declarative profile; the implementation does not invent an issuer/acquirer specification or treat synthetic echo tests as a real transaction.

## Payload

A protocol message with format `iso8583` contains a four-digit string `mti`, string-valued `fields`, and `profile`. The profile contains field definitions, optional ascii/bcd MTI encoding, 8/16-byte bitmap capacity, and a boolean two-byte big-endian length prefix (defaults: ascii, 16, true). Fields are declared by data-element number: 2–64 or 66–128 within the selected bitmap capacity. Reserved bitmap slots and undeclared fields fail before networking.

Supported kinds are numeric/text/binary, llvarNumeric/lllvarNumeric, llvarText/lllvarText, and llvarBinary/lllvarBinary. Each has a bounded length; numeric encoding and variable length-header encoding can explicitly select ascii/bcd. Text is printable ASCII. Binary fields use complete hexadecimal bytes, not arbitrary strings. XML conversion, dynamic schemas loaded from paths, tertiary/subfield profiles, scripts, custom executables and automatic authorization/retry are absent.

All framing, bitmaps, numeric/variable-length encoding and decoding are delegated to the maintained codec. The adapter bounds field count/length and body size (65,535 bytes), validates exact encodings and snapshots the decode profile before asynchronous network activity. A two-byte length prefix must agree exactly with the received bytes.

## Correctness guards

Evaluation found that the candidate can accept a short fixed numeric field while reporting bytesRead beyond the available bytes, ignore trailing bytes, and silently narrow Unicode passed to an ASCII field. The adapter therefore rejects non-ASCII input before encoding, requires complete decoder consumption, validates decoded values, and requires canonical byte-for-byte re-encoding. These are guards around the library, not replacement encoders or weakened tests.

One-shot TCP execution sends the resulting binary packet and attempts decoding with the same immutable profile. Raw base64/text views and actual size remain available. Successful decoded fields appear in `decoded`; an invalid/truncated response has `decodeError` while preserving raw evidence. Duration-cut TCP data remains marked partial/timedOut even when its collected bytes happen to form one valid packet. No request is replayed on parse or storage failure.

Saved protocol definitions retain the declarative packet through reload and project backup/restore. Interactive sessions can send the encoded bytes but still expose TCP chunks, not a new persistent ISO message-framing session. There is no new frontend or claim of original export compatibility.

The associated run-controller repair rejects malformed or already-active IDs in protocol, debug HTTP and load execution before starting another network operation. These routes cannot overwrite an existing cancellation controller. Existing plan/gRPC collision guards remain. Completed IDs can be reused; cancellation still targets the active operation rather than another project's concurrently submitted request.

## Acceptance

Tests use a hand-checked ASCII primary bitmap/length vector, secondary/binary/variable and BCD cases, deterministic encode/decode roundtrips, explicit invalid encoding/length/profile cases, and immutable profile behavior. Real local TCP fixtures cover valid echo and malformed replies. Authenticated HTTP execution reuses a saved definition before and after actual project restore; unauthorized requests make no network call. A separate concurrent-route fixture verifies collision refusal, cancellation ownership, cleanup/reuse and rejection of inherited protocol names. Only the exact commit's CI can establish the cross-platform result.

References: [codec source](https://github.com/tikpay-engineering/iso8583-ts), [package](https://www.npmjs.com/package/@tikpay/iso8583-ts).
