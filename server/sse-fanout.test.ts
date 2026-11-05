// Unit test for the SSE backpressure decision (PERF-02). This drives a fake
// response object directly instead of the real HTTP harness index.test.ts
// uses elsewhere: index.ts starts a real server on import, so it can't be
// imported into a unit test, which is why this logic lives in its own file.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { attachSseAbort, deliverSseFrame, SSE_MAX_BUFFERED_BYTES, writeSse, type SseFanoutClient } from "./sse-fanout.ts";

/** A fake client plus a handle on the drain listeners it queued. */
type TestClient = SseFanoutClient & { drains: (() => void)[] };

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): TestClient {
  const drains: (() => void)[] = [];
  return {
    backpressured: false,
    drains,
    res: {
      writableLength: 0,
      write: () => true,
      end: () => {},
      once: (_event: "drain", listener: () => void) => drains.push(listener),
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends normally while write() returns true", () => {
    const client = fakeClient();
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(false);
  });

  it("marks the client backpressured when write() returns false, without dropping that frame", () => {
    const client = fakeClient({ write: () => false });
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(true);
  });

  it("drops a replaceable screen frame once backpressured, but never drops a durable event", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false; // stays backpressured for every subsequent frame
      },
    });

    // First screen frame: not backpressured yet, so it's sent — and that
    // write's false return is what sets the flag.
    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);

    // Now backpressured: the next screen capture is replaceable, so it's
    // dropped rather than queued behind the stalled socket.
    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");

    // A durable event is not droppable — it still goes out even while
    // backpressured.
    expect(deliverSseFrame(client, "message", "message-1")).toBe("sent");

    expect(written).toEqual(["screen-1", "message-1"]);
  });

  it("disconnects a client once buffered bytes exceed the bound, even for a durable event", () => {
    let ended = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      end: () => {
        ended = true;
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
    expect(ended).toBe(true);
  });

  it("resumes screen frames once the socket drains", () => {
    // A single screen frame is bigger than the 16 KB highWaterMark, so a
    // perfectly healthy client's write() returns false too. If the flag
    // latched on for the life of the connection, that client would never see
    // another screen frame.
    let full = true;
    const client = fakeClient({ write: () => !full });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);
    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");
    expect(client.drains).toHaveLength(1);

    full = false;
    for (const drain of client.drains) drain();

    expect(client.backpressured).toBe(false);
    expect(deliverSseFrame(client, "screen", "screen-3")).toBe("sent");
  });

  it("queues one drain listener per backpressure episode, not per frame", () => {
    const client = fakeClient({ write: () => false });

    deliverSseFrame(client, "message", "message-1");
    deliverSseFrame(client, "message", "message-2");
    deliverSseFrame(client, "message", "message-3");

    expect(client.backpressured).toBe(true);
    expect(client.drains).toHaveLength(1);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
  });

  it("drops a frame when the response has already ended", () => {
    const client = fakeClient({ writableEnded: true });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
  });
});

describe("SSE response errors", () => {
  it("does not leave a write after the client disconnects unhandled", async () => {
    const unhandled: Error[] = [];
    const onUnhandled = (error: Error) => { unhandled.push(error); };
    process.on("uncaughtException", onUnhandled);
    let aborted = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      attachSseAbort(res, () => { aborted = true; });
      writeSse(res, "data: hello\n\n");
      req.on("close", () => {
        setTimeout(() => {
          // The response is finished. A bare res.write() here emits `error`
          // asynchronously; the abort listener has to absorb it.
          res.write("data: late\n\n");
          writeSse(res, "data: guarded\n\n");
        }, 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const req = fetch(`http://127.0.0.1:${port}/`).then(async (response) => {
          const reader = response.body?.getReader();
          const first = await reader?.read();
          expect(first?.value?.byteLength).toBeGreaterThan(0);
          await reader?.cancel();
        });
        req.then(() => setTimeout(resolve, 80)).catch(reject);
      });
      expect(aborted).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUnhandled);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
