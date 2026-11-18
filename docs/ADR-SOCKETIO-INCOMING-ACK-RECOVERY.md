# Socket.IO incoming acknowledgment local receipt recovery

This focused change recovers an explicit owner's lost incoming-ack response, not
arbitrary outbound events or unknown connection creation. Before invoking `/ack`,
the UI persists only the original session and server-issued incoming acknowledgment
ID alongside its existing uncertainty marker. Reload restores those identifiers;
explicit refresh reads the existing authenticated project/session endpoint.

The backend's existing bounded `ack-sent` event now distinguishes `unknown` from
`submitted`. It records unknown and consumes the one-shot acknowledgment ID before
calling the callback. Only normal callback return changes it to submitted. A throw
cannot create a false positive or allow replay. Submitted means local invocation,
not peer receipt or business success. Existing event count/byte retention bounds
apply; there is no new unbounded ledger. Evicted or older receipts without this
field cannot recover uncertainty. Restart cannot recreate the random session/ack
IDs and does not authorize reconnecting.

Read-only refresh resolves only a matching attempted ack whose local receipt says
submitted. Wrong IDs, unknown/missing receipts, unknown creation and stop/save
problems retain their guards. Persistence failure restores the unknown marker.
Starting another outbound send or stop invalidates old ack recovery identity so an
older receipt cannot clear a newer unrelated operation. No retransmission occurs.

Evidence: actual local Socket.IO server plus Workbench HTTP, entire ack response
lost, ID-only restore and GET recovery, one connection and one peer acknowledgment;
duplicate ack and cross-project reads rejected. Additional controller/actual app
adapter tests cover mismatch, unknown, missing, storage failure and stale proof.
A real transport session with deliberately throwing callback verifies unknown is
retained and the consumed ID cannot execute twice.

The shared project reload guard remains independent and may still require explicit
project reload before later mutations. Outbound event send and lost-ID connection
recovery are not implemented or claimed by this slice.
