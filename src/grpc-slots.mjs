// One admission pool for finite RPCs, reflection, plans and interactive sessions.
export class GrpcSlots {
  #active = 0;
  acquire() {
    if (this.#active >= 5) throw Error("最多同时执行5个gRPC调用");
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
    };
  }
}
