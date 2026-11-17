# Reject ambiguous modern inherited duplicate parameters

Static review of the official offline 2.0.0 send adapter (module 842216) shows that, when an ancestor contributes active rows of a parameter kind, it groups active rows by exact key, selects the last active entry in each group, and unions child then parent rows. Header union identities are lowercased. This is not the same behavior as preserving every repeated child row in the local converter.

Until full original normalization and inert source-row provenance are implemented together, modern import rejects active duplicates within a contributing ancestry layer. Header names compare case-insensitively; Query, Cookie and form parameter names compare case-sensitively. The guard applies only when an active ancestor contributes that parameter kind. Disabled duplicate rows remain inert and editable; ordinary requests without active ancestors still preserve repeated rows. Native local requests and other import formats are unchanged.

Import failure is atomic and does not execute endpoints or scripts. The message explains the unsupported source normalization rather than deleting a source row, selecting an arbitrary winner, or silently sending a different request. This is a compatibility restriction, not completed duplicate-parameter parity. Previously passing local duplicate-preservation tests demonstrated the converter's old contract, not the original adapter's behavior.

Tests cover all four parameter kinds, header casing, case-sensitive Query names, inactive duplicate rows, duplicate ancestor rows, preservation without active ancestry, unchanged source and target, and browser rejection without partial project resources. The source evidence is static inspection, not execution of the original application.
