import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/** Positional, transactional sink shared by browser files and caller-owned streams. */
export interface ExportWritableSink {
  write(chunk: StreamTargetChunk): Promise<unknown>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * The muxer may close its writer on cancellation, so only the job's explicit
 * commit is allowed to replace the destination file.
 */
export class ExportFileTarget {
  readonly target: StreamTarget;
  private aborted = false;
  private committed = false;
  private abortPromise: Promise<void> | null = null;
  private committing = false;
  private readonly fileStream: ExportWritableSink;

  constructor(fileStream: ExportWritableSink) {
    this.fileStream = fileStream;
    this.target = new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write: async (chunk) => {
          this.throwIfAborted();
          await fileStream.write(chunk);
          this.throwIfAborted();
        },
        // Output.cancel() closes its writer too. File commit belongs to us.
        close: () => {},
        abort: () => this.abort(),
      }),
      { chunked: true, chunkSize: 1024 * 1024 },
    );
  }

  private throwIfAborted(): void {
    if (this.aborted) throw new DOMException("Render cancelled", "AbortError");
  }

  async commit(): Promise<void> {
    this.throwIfAborted();
    this.committing = true;
    try {
      await this.fileStream.close();
      this.committed = true;
    } finally {
      this.committing = false;
    }
  }

  abort(): Promise<void> {
    if (this.committed || this.committing) return Promise.resolve();
    this.aborted = true;
    return (this.abortPromise ??= this.fileStream.abort());
  }
}
