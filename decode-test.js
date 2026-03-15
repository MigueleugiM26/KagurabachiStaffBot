const protobuf = require("protobufjs");
const fs = require("fs");

const data = fs.readFileSync(require("os").tmpdir() + "\\mp.bin");

// Raw decode — no schema, just dump every field number and value
const reader = protobuf.Reader.create(new Uint8Array(data));
const end = reader.len;
let depth = 0;

function readMessage(reader, end) {
  while (reader.pos < end) {
    const tag = reader.uint32();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      console.log(
        " ".repeat(depth * 2) +
          `field ${fieldNumber} (varint): ${reader.uint32()}`,
      );
    } else if (wireType === 1) {
      console.log(
        " ".repeat(depth * 2) +
          `field ${fieldNumber} (64-bit): ${reader.fixed64()}`,
      );
    } else if (wireType === 2) {
      const len = reader.uint32();
      const bytes = reader.buf.slice(reader.pos, reader.pos + len);
      reader.skip(len);

      // Try to interpret as UTF-8 string
      const str = Buffer.from(bytes).toString("utf8");
      const isPrintable = /^[\x20-\x7E\u00C0-\u024F\u3000-\u9FFF]*$/.test(str);

      if (isPrintable && str.length > 0) {
        console.log(
          " ".repeat(depth * 2) + `field ${fieldNumber} (string): "${str}"`,
        );
      } else {
        console.log(
          " ".repeat(depth * 2) +
            `field ${fieldNumber} (bytes/message): [${len} bytes]`,
        );
        // Try to recurse into it as a nested message
        try {
          const nested = protobuf.Reader.create(bytes);
          depth++;
          readMessage(nested, bytes.length);
          depth--;
        } catch {}
      }
    } else if (wireType === 5) {
      console.log(
        " ".repeat(depth * 2) +
          `field ${fieldNumber} (32-bit): ${reader.fixed32()}`,
      );
    } else {
      console.log(`Unknown wire type ${wireType} at offset ${reader.pos}`);
      break;
    }
  }
}

readMessage(reader, end);
