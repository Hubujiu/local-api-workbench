// One application's policy ordering, including memory publication. File rename
// alone cannot prevent an older remembered snapshot from restoring a revoked key.
export class MCPConfigPublication {
  #tail = Promise.resolve();
  constructor({ identity, snapshot, write }) {
    this.identity = identity;
    this.snapshot = snapshot;
    this.write = write;
  }
  run(operation) {
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => {});
    return task;
  }
  persist(identity) {
    return this.run(async () => {
      // An old dispatcher retains its own project array. Never promote it into
      // a policy the owner has since replaced, even if the token is unchanged.
      if (this.identity() !== identity) return false;
      const snapshot = this.snapshot();
      if (snapshot === null) return false;
      await this.write(snapshot);
      return true;
    });
  }
}
