import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

const MAX_ERROR_TAIL_BYTES = 8_192;

type WriteStream = ReturnType<typeof createWriteStream>;

export type OutputCapture = {
  readonly stdoutPath: string;
  readonly exceededOutputLimit: boolean;
  readonly stderrTail: string;
  // Feeds any buffered partial stdout line to onStdoutLine; call once the
  // process has closed.
  flush(): void;
  writeStderr(text: string): void;
  // Ends both files; resolves to the first write error, if any.
  close(): Promise<Error | undefined>;
};

// Tees a child's stdout/stderr to stdout.json/stderr.log in jobDir with
// backpressure, a per-stream byte cap (stops the process once exceeded), a
// bounded stderr tail, and line-split stdout delivered to onStdoutLine.
export function createOutputCapture(
  proc: ChildProcess,
  jobDir: string,
  maxOutputBytes: number,
  onStdoutLine: (line: string) => void,
  stopProcess: () => void
): OutputCapture {
  const stdoutPath = join(jobDir, "stdout.json");
  const stdoutFile = createWriteStream(stdoutPath);
  const stderrFile = createWriteStream(join(jobDir, "stderr.log"));
  const outputFinished = Promise.allSettled([finished(stdoutFile), finished(stderrFile)]);
  stdoutFile.on("error", stopProcess);
  stderrFile.on("error", stopProcess);

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTail = "";
  let stdoutLine = "";
  let exceededOutputLimit = false;
  const stdoutDecoder = new StringDecoder("utf8");

  const consumeStdout = (text: string) => {
    stdoutLine += text;
    const lines = stdoutLine.split(/\r?\n/);
    stdoutLine = lines.pop() ?? "";
    for (const line of lines) onStdoutLine(line);
  };
  const appendStderrTail = (data: Buffer) => {
    stderrTail += data.toString();
    if (Buffer.byteLength(stderrTail) > MAX_ERROR_TAIL_BYTES) {
      stderrTail = Buffer.from(stderrTail)
        .subarray(-MAX_ERROR_TAIL_BYTES)
        .toString("utf8");
    }
  };
  const drainListeners: Array<{ file: WriteStream; listener: () => void }> = [];
  const writeOutput = (target: "stdout" | "stderr", data: Buffer, file: WriteStream) => {
    if (!file.write(data)) {
      const source = target === "stdout" ? proc.stdout : proc.stderr;
      source?.pause();
      const listener = () => {
        drainListeners.splice(
          drainListeners.findIndex((entry) => entry.listener === listener),
          1
        );
        source?.resume();
      };
      drainListeners.push({ file, listener });
      file.once("drain", listener);
    }
  };
  const collect = (target: "stdout" | "stderr", data: Buffer) => {
    if (exceededOutputLimit) return;
    const bytes = target === "stdout" ? stdoutBytes : stderrBytes;
    if (bytes + data.length > maxOutputBytes) {
      exceededOutputLimit = true;
      stopProcess();
      return;
    }
    if (target === "stdout") {
      stdoutBytes += data.length;
      writeOutput("stdout", data, stdoutFile);
      consumeStdout(stdoutDecoder.write(data));
    } else {
      stderrBytes += data.length;
      writeOutput("stderr", data, stderrFile);
      appendStderrTail(data);
    }
  };
  proc.stdout?.on("data", (data: Buffer) => collect("stdout", data));
  proc.stderr?.on("data", (data: Buffer) => collect("stderr", data));

  return {
    stdoutPath,
    get exceededOutputLimit() {
      return exceededOutputLimit;
    },
    get stderrTail() {
      return stderrTail;
    },
    flush() {
      consumeStdout(stdoutDecoder.end());
      if (stdoutLine) onStdoutLine(stdoutLine);
    },
    writeStderr(text) {
      if (!stderrFile.destroyed) stderrFile.write(text);
    },
    async close() {
      for (const { file, listener } of drainListeners) {
        file.off("drain", listener);
      }
      drainListeners.length = 0;
      if (!stdoutFile.destroyed) stdoutFile.end();
      if (!stderrFile.destroyed) stderrFile.end();
      for (const output of await outputFinished) {
        if (output.status === "rejected") {
          return output.reason instanceof Error
            ? output.reason
            : new Error(String(output.reason));
        }
      }
    }
  };
}
