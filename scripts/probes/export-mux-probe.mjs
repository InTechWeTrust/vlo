// Read-only muxing experiment: uses real encoded packets, without WebCodecs or a GPU.
// Run from the repository root: node scripts/probes/export-mux-probe.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from "../../frontend/node_modules/mediabunny/dist/modules/src/index.js";

const fixture = new URL(
  "../../frontend/e2e/fixtures/project_current/vace_00003.mp4",
  import.meta.url,
);
const input = new Input({
  source: new BufferSource(await readFile(fixture)),
  formats: ALL_FORMATS,
});

try {
  const track = await input.getPrimaryVideoTrack();
  assert(track?.codec, "Fixture must have a supported video track");
  const decoderConfig = await track.getDecoderConfig();
  assert(decoderConfig);
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets.push(packet);
  }

  for (const fastStart of ["in-memory", false, "reserve"]) {
    for (const chunked of [false, true]) {
      const writes = [];
      let appendCursor = 0;
      let nonAppendWrites = 0;
      const target = new StreamTarget(
        new WritableStream({
          write(chunk) {
            if (chunk.position !== appendCursor) nonAppendWrites += 1;
            appendCursor += chunk.data.byteLength;
            writes.push(chunk);
          },
        }),
        { chunked, chunkSize: 1024 * 1024 },
      );
      const output = new Output({
        target,
        format: new Mp4OutputFormat({ fastStart }),
      });
      const source = new EncodedVideoPacketSource(track.codec);
      output.addVideoTrack(source, { maximumPacketCount: packets.length });
      await output.start();
      for (const packet of packets) {
        await source.add(packet, { decoderConfig });
      }
      await source.close();
      const bytesBeforeFinalize = appendCursor;
      await output.finalize();

      // Reconstruct the file using the offsets a correct disk adapter must honor.
      const fileSize = Math.max(
        ...writes.map((chunk) => chunk.position + chunk.data.byteLength),
      );
      const result = new Uint8Array(fileSize);
      for (const chunk of writes) result.set(chunk.data, chunk.position);
      const verification = new Input({
        source: new BufferSource(result),
        formats: ALL_FORMATS,
      });
      try {
        const renderedTrack = await verification.getPrimaryVideoTrack();
        assert(renderedTrack);
        let count = 0;
        for await (const packet of new EncodedPacketSink(renderedTrack).packets()) {
          assert.deepEqual(packet.data, packets[count]?.data);
          count += 1;
        }
        assert.equal(count, packets.length);
      } finally {
        verification.dispose();
      }

      console.log(JSON.stringify({
        fastStart,
        chunked,
        packets: packets.length,
        bytesBeforeFinalize,
        totalBytesWritten: appendCursor,
        fileSize,
        writes: writes.length,
        largestWrite: Math.max(...writes.map((chunk) => chunk.data.byteLength)),
        nonAppendWrites,
        packetPayloadsVerified: true,
      }));
    }
  }
} finally {
  input.dispose();
}
