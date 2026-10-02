import { PageFault, type Memory } from "../../src/vm/types";

/** A Memory backed by a Uint8Array mapped at `base`; everything else faults. */
export class FakeMemory implements Memory {
  readonly data: Uint8Array;
  private dv: DataView;
  constructor(readonly base: number, size: number) {
    this.data = new Uint8Array(size);
    this.dv = new DataView(this.data.buffer);
  }
  read(addr: number, len: number): Uint8Array {
    const off = (addr >>> 0) - this.base;
    if (off < 0 || off + len > this.data.length) throw new PageFault(addr >>> 0, "pte");
    return this.data.subarray(off, off + len);
  }
  w8(addr: number, v: number) { this.dv.setUint8((addr >>> 0) - this.base, v); }
  w16(addr: number, v: number) { this.dv.setUint16((addr >>> 0) - this.base, v, true); }
  w32(addr: number, v: number) { this.dv.setUint32((addr >>> 0) - this.base, v >>> 0, true); }
  w64(addr: number, v: bigint) { this.dv.setBigUint64((addr >>> 0) - this.base, BigInt.asUintN(64, v), true); }
  wstr(addr: number, s: string) {
    const b = new TextEncoder().encode(s);
    this.data.set(b, (addr >>> 0) - this.base);
    this.data[(addr >>> 0) - this.base + b.length] = 0;
  }
}
