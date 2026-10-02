// Small formatting + async helpers shared by the inspector components.

/** Hex-format a number or bigint, zero-padded to `width` digits (no "0x" if prefix=false). */
export function fmtHex(n: number | bigint, width = 8, prefix = true): string {
  let s: string;
  if (typeof n === "bigint") {
    s = (n < 0n ? BigInt.asUintN(64, n) : n).toString(16);
  } else {
    s = (n < 0 && n >= -0x80000000 ? n >>> 0 : n).toString(16);
  }
  return (prefix ? "0x" : "") + s.padStart(width, "0");
}

/** Decimal + hex, e.g. "255 (0xff)". */
export function fmtDecHex(n: number | bigint): string {
  const s = n.toString();
  const h = (typeof n === "bigint" ? n < 0n : n < 0) ? "" : ` (${fmtHex(n, 1)})`;
  return s + h;
}

export function fmtSize(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(n % (1 << 30) ? 2 : 0) + " GiB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(n % (1 << 20) ? 1 : 0) + " MiB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(n % (1 << 10) ? 1 : 0) + " KiB";
  return n + " B";
}

export function fmtCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Parse a user-typed number: hex (0x..), decimal. Returns undefined if not numeric. */
export function parseNum(s: string): number | undefined {
  s = s.trim().replace(/_/g, "");
  if (!s) return undefined;
  if (/^0x[0-9a-f]+$/i.test(s)) return Number(BigInt(s));
  if (/^[0-9]+$/.test(s)) return Number(s);
  return undefined;
}

export const PAGE_OFFSET = 0xc0000000;

export function perms(r: { writable: boolean; user: boolean }): string {
  return "r" + (r.writable ? "w" : "-") + (r.user ? "u" : "-");
}
