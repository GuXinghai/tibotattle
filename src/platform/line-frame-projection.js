// Optional projection of a complete oversized line. Retain bounded framing
// bytes only; the caller owns recognition and the closed projected contract.
const PREFIX_BYTES = 512;
const SUFFIX_BYTES = 128 * 1024;

export function createLineFrame(project) {
  if (typeof project !== 'function') throw new TypeError('lineFrameProjector must be a function');
  let prefix = Buffer.alloc(0), suffix = Buffer.alloc(0);
  return {
    append(bytes) {
      if (prefix.length < PREFIX_BYTES) prefix = Buffer.concat([prefix, bytes.subarray(0, PREFIX_BYTES-prefix.length)]);
      if (bytes.length >= SUFFIX_BYTES) suffix = Buffer.from(bytes.subarray(bytes.length-SUFFIX_BYTES));
      else if (bytes.length) suffix = Buffer.concat([suffix.subarray(Math.max(0,suffix.length+bytes.length-SUFFIX_BYTES)),bytes]);
    },
    finish() {
      return checkedProjection(project({prefix:prefix.toString('utf8'),suffix:suffix.toString('utf8'),oversized:true}));
    },
  };
}

function checkedProjection(value) {
  if (value !== undefined && value !== null && (typeof value !== 'string' || Buffer.byteLength(value)>SUFFIX_BYTES)) {
    throw new TypeError('lineFrameProjector returned an invalid projection');
  }
  return value;
}

export function projectCompleteLine(project, bytes) {
  return checkedProjection(project({prefix:bytes.subarray(0,PREFIX_BYTES).toString('utf8'),
    suffix:bytes.subarray(Math.max(0,bytes.length-SUFFIX_BYTES)).toString('utf8'),oversized:false}));
}
