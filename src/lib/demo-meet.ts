export const DEMO_MEET_ID = "demo";

const ATTEMPT_MS = 5_000;
const SLOW_MS = 12_000;
const BREAK_MS = 12_000;
const POLL_LIMIT_MS = 8_000;
const PLATFORM_ID = "platform-demo";
const LIFTS = ["squat", "bench", "deadlift"] as const;
const LIFT_CODE = { squat: "s", bench: "b", deadlift: "d" };

type Lift = (typeof LIFTS)[number];
type Doc = Record<string, unknown> & { _id: string };
type Attempt = {
  _id: string;
  lifterId: string;
  liftName: Lift;
  attemptNumber: string;
  weight: number;
};
type Slot = {
  kind: "attempt" | "break";
  start: number;
  end: number;
  attemptId?: string;
  result?: "good" | "bad";
};

const ROSTER = [
  { id: "ldemoa01", name: "Maya Chen", flight: "A", lot: 101, squat: 90, bench: 55, deadlift: 115 },
  { id: "ldemoa02", name: "Luis Ortega", flight: "A", lot: 102, squat: 110, bench: 75, deadlift: 140 },
  { id: "ldemoa03", name: "Priya Shah", flight: "A", lot: 103, squat: 125, bench: 70, deadlift: 150 },
  { id: "ldemoa04", name: "Owen Blake", flight: "A", lot: 104, squat: 150, bench: 100, deadlift: 185 },
  { id: "ldemob01", name: "Nora Kim", flight: "B", lot: 201, squat: 100, bench: 60, deadlift: 125 },
  { id: "ldemob02", name: "Samir Adeyemi", flight: "B", lot: 202, squat: 140, bench: 90, deadlift: 175 },
  { id: "ldemob03", name: "Elena Voss", flight: "B", lot: 203, squat: 160, bench: 95, deadlift: 190 },
  { id: "ldemob04", name: "Jonah Park", flight: "B", lot: 204, squat: 180, bench: 115, deadlift: 215 },
];

const SLOW = new Set(["a2s-ldemoa02"]);
const BAD = new Set(["a1s-ldemoa02", "a1b-ldemoa03"]);
const MUTATIONS: Array<
  | { after: string; type: "scratch"; attemptId: string }
  | { after: string; type: "weight"; attemptId: string; weight: number }
> = [
  { after: "a1s-ldemoa04", type: "scratch", attemptId: "a3s-ldemob01" },
  { after: "a1s-ldemob03", type: "weight", attemptId: "a1b-ldemob02", weight: 110 },
];

let origin: number | null = null;
let cachedSchedule: {
  slots: Slot[];
  scratchAt: Map<string, number>;
  weights: Map<string, Array<{ at: number; weight: number }>>;
  initial: Map<string, Attempt>;
} | null = null;

export function resetDemo(now: number) {
  origin = now;
}

function demoOrigin(now: number) {
  if (origin === null) origin = now;
  return origin;
}

function attemptId(lift: Lift, round: number, lifterId: string) {
  return `a${round}${LIFT_CODE[lift]}-${lifterId}`;
}

function baseAttempts() {
  const attempts = new Map<string, Attempt>();
  for (const lifter of ROSTER) {
    for (const lift of LIFTS) {
      for (let round = 1; round <= 3; round++) {
        const id = attemptId(lift, round, lifter.id);
        attempts.set(id, {
          _id: id,
          lifterId: lifter.id,
          liftName: lift,
          attemptNumber: String(round),
          weight: lifter[lift] + (round - 1) * 5,
        });
      }
    }
  }
  return attempts;
}

function lifterById(id: string) {
  const lifter = ROSTER.find((item) => item.id === id);
  if (!lifter) throw new Error(`Unknown demo lifter ${id}`);
  return lifter;
}

function nextAttempt(attempts: Map<string, Attempt>, done: Set<string>, scratched: Set<string>) {
  for (const liftName of LIFTS) {
    for (const flight of ["A", "B"]) {
      for (let round = 1; round <= 3; round++) {
        const group = [...attempts.values()]
          .filter((attempt) => {
            const lifter = lifterById(attempt.lifterId);
            return (
              lifter.flight === flight &&
              attempt.liftName === liftName &&
              Number(attempt.attemptNumber) === round &&
              !done.has(attempt._id) &&
              !scratched.has(attempt._id)
            );
          })
          .sort(
            (a, b) =>
              a.weight - b.weight ||
              lifterById(a.lifterId).lot - lifterById(b.lifterId).lot,
          );
        if (group[0]) return group[0];
      }
    }
  }
  return null;
}

function schedule() {
  if (cachedSchedule) return cachedSchedule;
  const attempts = baseAttempts();
  const initial = baseAttempts();
  const done = new Set<string>();
  const scratched = new Set<string>();
  const scratchAt = new Map<string, number>();
  const weights = new Map<string, Array<{ at: number; weight: number }>>();
  const slots: Slot[] = [];
  let time = 0;
  let previousLift: Lift | null = null;

  while (true) {
    const attempt = nextAttempt(attempts, done, scratched);
    if (!attempt) break;
    if (previousLift && previousLift !== attempt.liftName) {
      slots.push({ kind: "break", start: time, end: time + BREAK_MS });
      time += BREAK_MS;
    }
    const duration = SLOW.has(attempt._id) ? SLOW_MS : ATTEMPT_MS;
    slots.push({
      kind: "attempt",
      start: time,
      end: time + duration,
      attemptId: attempt._id,
      result: BAD.has(attempt._id) ? "bad" : "good",
    });
    time += duration;
    done.add(attempt._id);
    previousLift = attempt.liftName;

    for (const mutation of MUTATIONS.filter((item) => item.after === attempt._id)) {
      if (mutation.type === "scratch") {
        scratched.add(mutation.attemptId);
        scratchAt.set(mutation.attemptId, time);
      } else {
        const target = attempts.get(mutation.attemptId);
        if (!target || done.has(target._id)) continue;
        target.weight = mutation.weight;
        const history = weights.get(target._id) ?? [];
        history.push({ at: time, weight: mutation.weight });
        weights.set(target._id, history);
      }
    }
  }

  cachedSchedule = { slots, scratchAt, weights, initial };
  return cachedSchedule;
}

function weightAt(id: string, elapsed: number) {
  const plan = schedule();
  let weight = plan.initial.get(id)?.weight ?? 0;
  for (const change of plan.weights.get(id) ?? []) {
    if (change.at <= elapsed) weight = change.weight;
  }
  return weight;
}

function timeForCursor(cursor: number) {
  if (cursor <= 0) return 0;
  const { slots } = schedule();
  return slots[Math.min(cursor, slots.length) - 1]?.end ?? 0;
}

function docsAt(elapsed: number, startedAt: number) {
  const plan = schedule();
  const completed = new Map(
    plan.slots
      .filter((slot) => slot.kind === "attempt" && slot.end <= elapsed && slot.attemptId)
      .map((slot) => [slot.attemptId as string, slot]),
  );
  const current = plan.slots.find(
    (slot) => slot.kind === "attempt" && slot.start <= elapsed && elapsed < slot.end,
  );
  const docs: Doc[] = [
    {
      _id: DEMO_MEET_ID,
      name: "Demo Platform",
      units: "KG",
      date: "Demo",
      federation: "DEMO",
    },
    {
      _id: PLATFORM_ID,
      name: "1",
      clockState: current ? "started" : "initial",
      clockTimerLength: 60000,
      barAndCollarsWeight: 25,
      currentAttemptId: current?.attemptId ?? null,
    },
  ];

  for (const lifter of ROSTER) {
    docs.push({
      _id: lifter.id,
      name: lifter.name,
      flight: lifter.flight,
      session: 1,
      lot: lifter.lot,
      platformId: PLATFORM_ID,
    });
  }

  for (const attempt of plan.initial.values()) {
    const scratchedAt = plan.scratchAt.get(attempt._id);
    if (scratchedAt !== undefined && scratchedAt <= elapsed) continue;
    const slot = completed.get(attempt._id);
    const doc: Doc = {
      _id: attempt._id,
      lifterId: attempt.lifterId,
      liftName: attempt.liftName,
      attemptNumber: attempt.attemptNumber,
      weight: weightAt(attempt._id, elapsed),
    };
    if (slot?.result) {
      doc.result = slot.result;
      doc.changes = [
        {
          attribute: "result",
          value: slot.result,
          timeStamp: new Date(startedAt + slot.end).toISOString(),
        },
      ];
    }
    docs.push(doc);
  }

  const cursor = plan.slots.filter((slot) => slot.end <= elapsed).length;
  const nextEnd = plan.slots.find((slot) => slot.end > elapsed)?.end;
  return {
    cursor,
    remainingMs: nextEnd === undefined ? null : nextEnd - elapsed,
    docs,
  };
}

function changedDocs(previous: Doc[], next: Doc[]) {
  const before = new Map(previous.map((doc) => [doc._id, doc]));
  const after = new Map(next.map((doc) => [doc._id, doc]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].flatMap((id) => {
    const oldDoc = before.get(id);
    const newDoc = after.get(id);
    if (oldDoc && !newDoc) return [{ id, deleted: true }];
    if (newDoc && JSON.stringify(oldDoc) !== JSON.stringify(newDoc)) {
      return [{ id, deleted: false, doc: newDoc }];
    }
    return [];
  });
}

export function demoFrame(now: number, since: string | null, reset = false, skipMs = 0) {
  const parsed = reset ? null : since?.match(/^(\d+):(\d+)$/);
  const startedAt = parsed ? Number(parsed[1]) : demoOrigin(now);
  const elapsed = Math.max(0, now - startedAt + Math.max(0, skipMs));
  const current = docsAt(elapsed, startedAt);
  const sequence = `${startedAt}:${current.cursor}`;

  if (!parsed) {
    return {
      mode: "snapshot" as const,
      sequence,
      docs: current.docs.map((doc) => ({ id: doc._id, deleted: false, doc })),
      waitMs: 0,
    };
  }

  const sinceCursor = Number(parsed?.[2] ?? 0);
  if (sinceCursor !== current.cursor) {
    const previous = docsAt(timeForCursor(sinceCursor), startedAt);
    return {
      mode: "changes" as const,
      sequence,
      docs: changedDocs(previous.docs, current.docs),
      waitMs: 0,
    };
  }

  return {
    mode: "changes" as const,
    sequence,
    docs: [],
    waitMs: current.remainingMs === null ? POLL_LIMIT_MS : Math.min(POLL_LIMIT_MS, current.remainingMs),
  };
}

export function advanceDemo(now: number, since: string | null, skipMs = 0) {
  const parsed = since?.match(/^(\d+):(\d+)$/);
  const startedAt = parsed ? Number(parsed[1]) : demoOrigin(now);
  const rawElapsed = Math.max(0, now - startedAt);
  const elapsed = rawElapsed + Math.max(0, skipMs);
  const slots = schedule().slots;
  const next = slots.find((slot) => slot.kind === "attempt" && slot.start > elapsed);
  const current = slots.find(
    (slot) => slot.kind === "attempt" && slot.start <= elapsed && elapsed < slot.end,
  );
  const target = next?.start ?? current?.end;
  const skip = target === undefined ? Math.max(0, skipMs) : target - rawElapsed;
  return { ...demoFrame(now, since, false, skip), skip };
}
