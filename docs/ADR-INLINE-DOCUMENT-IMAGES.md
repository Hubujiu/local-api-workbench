# Offline embedded document images

Document editor accepts explicitly selected PNG/JPEG images up to128KiB. Validate signature and declared dimensions before browser decoding, then require createImageBitmap decoding to succeed before inserting a data URI at the selection. The dimensions are capped at4096 per side and16million pixels. A stale asynchronous file read cannot modify a closed/reopened document editor. Cancelling the editor does not mutate the project.

Markdown can render only these bounded embedded data images, not remote, file or SVG images; raw HTML remains disabled. Rendering also caps aggregate declared image pixels per Markdown body at16million. Embedded data links are not navigable. Existing256KiB Markdown preview bound remains. Images are part of the ordinary project/Markdown export, while offline HTML export explicitly allows only data images through its CSP. No upload service or remote image fetch is introduced. Header validation is not full file validation; browser decoder validation applies to editor uploads.

Unit tests cover image embedding, invalid/active/remote formats, byte/dimension/aggregate ceilings, source/bundle parity and export CSP. Browser exercises rejected invalid input, native PNG decoding, insertion, saving and rendered preview. This adds offline local images, not online hosting or unrestricted HTML compatibility.
