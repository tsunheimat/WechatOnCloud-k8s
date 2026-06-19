import zlib from 'node:zlib';

// Minimal USTAR tar encoder — the single source of truth shared by the Docker runtime and the
// Kubernetes runtime (avoids a third-party dependency). Previously this header logic was copy-pasted
// in five places (docker.ts ×2, kubernetes-exec.ts, kubernetes-runtime.ts), so encoding fixes had to
// be made in every copy; keep all callers pointed here.

const NAME_FIELD = 100; // ustar name field is bytes 0..99
// 11 octal digits + 1 NUL terminator live in the 12-byte size field (124..135). The largest value that
// fits is 0o77777777777 = 8 GiB - 1; beyond that the field overflows its terminator → non-conforming.
const MAX_CONTENT = 0o77777777777;

// The name occupies a fixed 100-BYTE field. `String.prototype.slice`/`Buffer.write` count UTF-16 code
// units, so a multibyte (e.g. CJK) filename could exceed 100 bytes, overflow into the mode field, and
// split a codepoint — corrupting the header. Truncate on a UTF-8 boundary so the encoded name is always
// valid and <= 100 bytes.
function encodeName(name: string): Buffer {
  const buf = Buffer.from(name, 'utf8');
  if (buf.length <= NAME_FIELD) return buf;
  let end = NAME_FIELD;
  // back off past any UTF-8 continuation byte (10xxxxxx) so we never cut a codepoint in half
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

function tarHeader(name: string, content: Buffer): Buffer {
  if (content.length > MAX_CONTENT) {
    throw new Error(`文件过大，无法写入 tar（${content.length} 字节，单文件上限约 8 GiB）`);
  }
  const h = Buffer.alloc(512, 0);
  encodeName(name).copy(h, 0, 0, NAME_FIELD); // name (bounded to the 100-byte field)
  h.write('0000644\0', 100); // mode
  h.write('0001750\0', 108); // uid 1000 (octal 1750)
  h.write('0001750\0', 116); // gid 1000
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124); // size
  h.write('00000000000\0', 136); // mtime
  h.write('        ', 148); // checksum placeholder (8 spaces)
  h.write('0', 156); // typeflag = regular file
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); // real checksum
  return h;
}

// A single tar entry: header + content + 512-byte alignment padding (no end-of-archive marker).
export function tarEntry(name: string, content: Buffer): Buffer {
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([tarHeader(name, content), content, Buffer.alloc(pad, 0)]);
}

// A complete single-file archive: one entry plus the 1024-byte (two empty blocks) end-of-archive marker.
export function tarSingleFile(name: string, content: Buffer): Buffer {
  return Buffer.concat([tarEntry(name, content), Buffer.alloc(1024, 0)]);
}

// A multi-file tar.gz built in memory (used for diagnostic bundles, typically a few MB).
export function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')));
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}
