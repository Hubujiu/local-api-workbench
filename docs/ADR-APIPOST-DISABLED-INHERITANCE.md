# Disabled rows in modern parameter inheritance

Static inspection of the offline 2.0.0 send adapter (module 842216) shows that inactive child header/query/cookie rows do not suppress an active ancestor merely by sharing its name. The modern converter previously used every child key for replacement, causing the inherited value to disappear from the actual request.

Only enabled child rows now replace an ancestor name group. Disabled child rows remain in the converted editable definition but stay inactive at execution. Header identity remains case-insensitive; query and cookie identity remains case-sensitive. Absent flags retain the existing converter's legacy-enabled default; this is not a claim of complete original schema equivalence. Duplicate active rows retain the existing explicit-row preservation contract rather than silently discarding input. Full original deduplication and system-row flag semantics remain separate compatibility work.

Independent real HTTP fixtures verify all three parameter kinds through project, folder and request scopes, source immutability, and retained disabled rows. A browser grouped-sample fixture verifies that disabled folder/sample headers do not remove the global value. No runtime sandbox, permission or quota changes are involved.
