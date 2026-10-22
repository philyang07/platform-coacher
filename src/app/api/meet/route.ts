import { NextRequest, NextResponse } from "next/server";
import { DEMO_MEET_ID, demoFrame, resetDemo } from "@/lib/demo-meet";

const COUCH = "https://couchdb.liftingcast.com";
const MEET_ID = /^[a-z0-9]{12}$/;
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function demoResponse(request: NextRequest, since: string | null) {
  const reset = request.nextUrl.searchParams.get("reset") === "1";
  if (reset) resetDemo(Date.now());
  let frame = demoFrame(Date.now(), since, reset);
  if (frame.waitMs > 0) {
    await sleep(frame.waitMs, request.signal);
    frame = demoFrame(Date.now(), since);
  }
  return NextResponse.json(
    { mode: frame.mode, sequence: frame.sequence, docs: frame.docs },
    { headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  const meetId = request.nextUrl.searchParams.get("meetId") ?? "";
  const since = request.nextUrl.searchParams.get("since");

  if (meetId === DEMO_MEET_ID) return demoResponse(request, since);

  if (!MEET_ID.test(meetId)) {
    return NextResponse.json({ error: "Invalid LiftingCast meet ID" }, { status: 400 });
  }

  const database = `${COUCH}/${meetId}_readonly`;
  const url = since
    ? `${database}/_changes?include_docs=true&feed=longpoll&conflicts=true&timeout=8000&limit=100&since=${encodeURIComponent(since)}`
    : `${database}/_all_docs?conflicts=true&update_seq=true&include_docs=true`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `LiftingCast returned ${response.status}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    const payload = since
      ? {
          mode: "changes",
          sequence: data.last_seq,
          docs: data.results.map(
            (result: { id: string; deleted?: boolean; doc?: Record<string, unknown> }) => ({
              id: result.id,
              deleted: Boolean(result.deleted),
              doc: result.doc,
            }),
          ),
        }
      : {
          mode: "snapshot",
          sequence: data.update_seq,
          docs: data.rows.map(
            (row: { id: string; doc?: Record<string, unknown> }) => ({
              id: row.id,
              deleted: false,
              doc: row.doc,
            }),
          ),
        };

    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    if (since && error instanceof Error && error.name === "TimeoutError") {
      return NextResponse.json(
        { mode: "changes", sequence: since, docs: [] },
        { headers: NO_STORE },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown upstream error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
