"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Board from "./board";

type Doc = Record<string, unknown> & { _id?: string };
type Warmup = { id: number; weight: string; gap: number };
type ApiDoc = { id: string; deleted: boolean; doc?: Doc };

const DEFAULT_MEET = "demo";
const LIFTS = ["squat", "bench", "deadlift"];

const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) =>
  typeof value === "number" ? value : Number(value) || 0;

function resultTime(doc: Doc) {
  const changes = Array.isArray(doc.changes) ? doc.changes : [];
  const result = [...changes]
    .reverse()
    .find((change) => (change as Doc).attribute === "result") as Doc | undefined;
  return result ? Date.parse(text(result.timeStamp)) || 0 : 0;
}

function formatTime(date: Date | null) {
  return date
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(date)
    : "—";
}

function extractMeetId(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "demo") return "demo";
  const match = trimmed.match(/(?:meets\/)?([a-z0-9]{12})(?:\/|$)/);
  return match?.[1] ?? "";
}

export default function Planner() {
  const [meetInput, setMeetInput] = useState(DEFAULT_MEET);
  const [meetId, setMeetId] = useState(DEFAULT_MEET);
  const [docs, setDocs] = useState<Map<string, Doc>>(new Map());
  const [sequence, setSequence] = useState("");
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [lifterId, setLifterId] = useState("");
  const [lift, setLift] = useState("squat");
  const [pace, setPace] = useState(75);
  const [breakMinutes, setBreakMinutes] = useState(10);
  const [liftGapMinutes, setLiftGapMinutes] = useState(10);
  const [feedKey, setFeedKey] = useState(0);
  const [view, setView] = useState<"planner" | "board">("planner");
  const [warmups, setWarmups] = useState<Warmup[]>([
    { id: 1, weight: "Bar", gap: 5 },
    { id: 2, weight: "60", gap: 5 },
    { id: 3, weight: "100", gap: 5 },
    { id: 4, weight: "130", gap: 8 },
  ]);
  const docsRef = useRef(docs);
  const sequenceRef = useRef(sequence);

  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);
  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    const saved = localStorage.getItem("platform-coacher-settings");
    if (!saved) return;
    try {
      const value = JSON.parse(saved);
      queueMicrotask(() => {
        if (Array.isArray(value.warmups)) setWarmups(value.warmups);
      if (value.pace) setPace(value.pace);
      if (value.breakMinutes) setBreakMinutes(value.breakMinutes);
      if (value.liftGapMinutes) setLiftGapMinutes(value.liftGapMinutes);
      });
    } catch {
      // Ignore stale local data.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "platform-coacher-settings",
      JSON.stringify({ warmups, pace, breakMinutes, liftGapMinutes }),
    );
  }, [warmups, pace, breakMinutes, liftGapMinutes]);

  useEffect(() => {
    let cancelled = false;
    const initialDocs = new Map<string, Doc>();
    docsRef.current = initialDocs;
    sequenceRef.current = "";
    queueMicrotask(() => {
      if (cancelled) return;
      setDocs(initialDocs);
      setSequence("");
      setStatus("loading");
      setError("");
    });

    async function poll() {
      while (!cancelled) {
        try {
          const params = new URLSearchParams({ meetId });
          if (sequenceRef.current) params.set("since", sequenceRef.current);
          const response = await fetch(`/api/meet?${params}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "Could not load meet");
          if (cancelled) return;

          const next =
            data.mode === "snapshot" ? new Map<string, Doc>() : new Map(docsRef.current);
          for (const item of data.docs as ApiDoc[]) {
            if (item.deleted) next.delete(item.id);
            else if (item.doc) next.set(item.id, item.doc);
          }
          docsRef.current = next;
          sequenceRef.current = data.sequence;
          setDocs(next);
          setSequence(data.sequence);
          setUpdatedAt(new Date());
          setStatus("live");
          setError("");
        } catch (reason) {
          if (cancelled) return;
          setStatus("error");
          setError(reason instanceof Error ? reason.message : "Connection failed");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [meetId, feedKey]);

  const model = useMemo(() => {
    const all = [...docs.values()];
    const meet = docs.get(meetId);
    const lifters = all
      .filter(
        (doc) =>
          text(doc._id).startsWith("l") &&
          typeof doc.name === "string" &&
          doc.flight !== undefined &&
          doc.platformId !== undefined,
      )
      .sort((a, b) => text(a.name).localeCompare(text(b.name)));
    const attempts = all.filter(
      (doc) => doc.lifterId && doc.liftName && doc.attemptNumber,
    );
    const platforms = all.filter((doc) => "currentAttemptId" in doc);
    return { meet, lifters, attempts, platforms };
  }, [docs, meetId]);

  const activeLifterId = model.lifters.some((item) => item._id === lifterId)
    ? lifterId
    : text(model.lifters[0]?._id);

  const estimates = useMemo(() => {
    const lifter = model.lifters.find((item) => item._id === activeLifterId);
    if (!lifter) return null;
    const relevantLifters = model.lifters.filter(
      (item) =>
        item.platformId === lifter.platformId && item.session === lifter.session,
    );
    const lifterById = new Map(relevantLifters.map((item) => [item._id, item]));
    const flights = [
      ...new Set(relevantLifters.map((item) => text(item.flight))),
    ].sort();
    const ordered: Doc[] = [];

    for (const liftName of LIFTS) {
      for (const flight of flights) {
        for (let round = 1; round <= 3; round++) {
          const flightAttempts = model.attempts
            .filter((item) => {
              const owner = lifterById.get(item.lifterId as string);
              return (
                owner &&
                owner.flight === flight &&
                item.liftName === liftName &&
                number(item.attemptNumber) === round
              );
            })
            .sort((a, b) => {
              const weightA = typeof a.weight === "number" ? a.weight : Infinity;
              const weightB = typeof b.weight === "number" ? b.weight : Infinity;
              return (
                weightA -
                  weightB ||
                number(lifterById.get(a.lifterId as string)?.lot) -
                  number(lifterById.get(b.lifterId as string)?.lot)
              );
            });
          ordered.push(...flightAttempts);
        }
      }
    }

    const platform = model.platforms.find((item) => item._id === lifter.platformId);
    let currentId = text(platform?.currentAttemptId);
    if (!currentId) {
      currentId =
        [...ordered].sort((a, b) => resultTime(b) - resultTime(a))[0]?._id ?? "";
    }
    const currentIndex = ordered.findIndex((item) => item._id === currentId);

    return LIFTS.map((liftName) => {
      const target = model.attempts.find(
        (item) =>
          item.lifterId === activeLifterId &&
          item.liftName === liftName &&
          number(item.attemptNumber) === 1,
      );
      if (!target) return { lift: liftName, state: "unavailable" as const };
      if (target.result) {
        return {
          lift: liftName,
          state: "complete" as const,
          target,
          at: resultTime(target) ? new Date(resultTime(target)) : null,
        };
      }
      const targetIndex = ordered.findIndex((item) => item._id === target._id);
      if (targetIndex < 0 || currentIndex < 0) {
        return { lift: liftName, state: "waiting" as const, target };
      }
      if (targetIndex <= currentIndex) {
        return { lift: liftName, state: "passed" as const, target };
      }

      const ahead = ordered.slice(currentIndex + 1, targetIndex + 1);
      let flightBreaks = 0;
      let liftBreaks = 0;
      let previous = ordered[currentIndex];
      for (const attempt of ahead) {
        const previousOwner = lifterById.get(previous.lifterId as string);
        const owner = lifterById.get(attempt.lifterId as string);
        if (attempt.liftName !== previous.liftName) liftBreaks++;
        else if (owner?.flight !== previousOwner?.flight) flightBreaks++;
        previous = attempt;
      }
      const seconds =
        ahead.length * pace +
        flightBreaks * breakMinutes * 60 +
        liftBreaks * liftGapMinutes * 60;
      return {
        lift: liftName,
        state: "estimated" as const,
        target,
        at: new Date((updatedAt?.getTime() ?? 0) + seconds * 1000),
        attempts: ahead.length,
        flightBreaks,
        liftBreaks,
        uncertainty: Math.max(
          2,
          Math.ceil((ahead.length * 10) / 60 + flightBreaks * 2 + liftBreaks * 3),
        ),
      };
    });
  }, [model, activeLifterId, pace, breakMinutes, liftGapMinutes, updatedAt]);

  const estimate = estimates?.find((item) => item.lift === lift) ?? null;

  const timeline = useMemo(() => {
    if (estimate?.state !== "estimated") return [];
    let cursor = estimate.at.getTime();
    return [...warmups]
      .reverse()
      .map((warmup) => {
        cursor -= warmup.gap * 60_000;
        return { ...warmup, at: new Date(cursor) };
      })
      .reverse();
  }, [estimate, warmups]);

  async function watchDemo() {
    try {
      const response = await fetch("/api/meet?meetId=demo&reset=1");
      if (!response.ok) throw new Error("Could not start the demo");
      setMeetInput("demo");
      setLifterId("");
      setMeetId("demo");
      setFeedKey((key) => key + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the demo");
    }
  }

  function loadMeet(event: React.FormEvent) {
    event.preventDefault();
    const id = extractMeetId(meetInput);
    if (!id) {
      setError("Enter a LiftingCast meet URL or 12-character meet ID");
      return;
    }
    setLifterId("");
    setMeetId(id);
  }

  function updateWarmup(id: number, patch: Partial<Warmup>) {
    setWarmups((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  const selectedLifter = model.lifters.find((item) => item._id === activeLifterId);
  const activePlatform = model.platforms.find(
    (item) => item._id === selectedLifter?.platformId,
  );
  const currentAttempt = model.attempts.find(
    (item) => item._id === activePlatform?.currentAttemptId,
  );
  const currentLifter = model.lifters.find(
    (item) => item._id === currentAttempt?.lifterId,
  );
  const platformAttempts = model.attempts.filter(
    (item) =>
      model.lifters.find((lifter) => lifter._id === item.lifterId)?.platformId ===
      activePlatform?._id,
  );
  const barStatus = currentLifter
    ? `On the bar · ${text(currentLifter.name)} · ${text(currentAttempt?.liftName)} ${text(currentAttempt?.attemptNumber)} · ${number(currentAttempt?.weight)} ${text(model.meet?.units).toLowerCase()}`
    : platformAttempts.length > 0 && platformAttempts.every((item) => item.result)
      ? "Platform finished"
      : platformAttempts.some((item) => item.result)
        ? "Flight break"
        : "Waiting for the platform";
  const estimateTarget =
    estimate && "target" in estimate ? estimate.target : undefined;
  const targetWeight =
    estimateTarget && typeof estimateTarget.weight === "number"
      ? `${estimateTarget.weight} ${text(model.meet?.units).toLowerCase()}`
      : "not declared";

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span>PC</span> Platform Coacher
        </div>
        <div className={`connection ${status}`}>
          <i />{" "}
          {status === "live"
            ? "Live"
            : status === "loading"
              ? "Connecting"
              : "Offline"}
        </div>
      </header>

      <div className="shell">
        <section className="hero">
          <p className="eyebrow">LiftingCast warm-up planner</p>
          <h1>{text(model.meet?.name) || "Plan the platform, not the clock."}</h1>
          <p className="subhead">
            Live attempt order becomes a warm-up schedule for your lifter.
          </p>
          <form className="meet-form" onSubmit={loadMeet}>
            <input
              aria-label="Meet URL or ID"
              value={meetInput}
              onChange={(event) => setMeetInput(event.target.value)}
              placeholder="LiftingCast meet URL or ID"
            />
            <button>Load meet</button>
            <button type="button" className="ghost" onClick={watchDemo}>
              {meetId === "demo" ? "Restart demo" : "Watch demo"}
            </button>
          </form>
          {meetId === "demo" && (
            <p className="demo-note">
              Simulated platform. Most attempts take 5 seconds. The script also
              includes a slow attempt, flight breaks, a weight change, and a scratch.
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <div className="tabs" role="tablist" aria-label="Views">
          <button
            type="button"
            role="tab"
            aria-selected={view === "planner"}
            onClick={() => setView("planner")}
          >
            Planner
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "board"}
            onClick={() => setView("board")}
          >
            Board
          </button>
        </div>

        {view === "board" ? (
          <Board
            lifters={model.lifters}
            attempts={model.attempts}
            platforms={model.platforms}
            currentAttempt={currentAttempt}
            units={text(model.meet?.units).toLowerCase()}
            selectedLifterId={activeLifterId}
            onSelectLifter={setLifterId}
          />
        ) : (
          <>
        <section className="controls card">
          <label>
            Lifter
            <select
              value={activeLifterId}
              onChange={(event) => setLifterId(event.target.value)}
            >
              {model.lifters.map((item) => (
                <option key={text(item._id)} value={text(item._id)}>
                  {text(item.name)} · Flight {text(item.flight)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lift
            <select value={lift} onChange={(event) => setLift(event.target.value)}>
              {LIFTS.map((item) => (
                <option key={item} value={item}>
                  {item[0].toUpperCase() + item.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seconds / attempt
            <input
              type="number"
              min="30"
              max="180"
              value={pace}
              onChange={(event) => setPace(+event.target.value)}
            />
          </label>
          <label>
            Between flights
            <div className="input-suffix">
              <input
                type="number"
                min="0"
                max="60"
                value={breakMinutes}
                onChange={(event) => setBreakMinutes(+event.target.value)}
              />
              <span>min</span>
            </div>
          </label>
          <label>
            Between lifts
            <div className="input-suffix">
              <input
                type="number"
                min="0"
                max="60"
                value={liftGapMinutes}
                onChange={(event) => setLiftGapMinutes(+event.target.value)}
              />
              <span>min</span>
            </div>
          </label>
        </section>

        <section className="grid">
          <div className="card forecast">
            <div className="section-title">
              <div>
                <p className="eyebrow">First attempt forecast</p>
                <h2>
                  {selectedLifter ? text(selectedLifter.name) : "Select a lifter"}
                </h2>
              </div>
              <span className="flight">
                Flight {text(selectedLifter?.flight) || "—"}
              </span>
            </div>
            <p className="bar-status">{barStatus}</p>

            {estimate?.state === "estimated" ? (
              <>
                <div className="big-time">{formatTime(estimate.at)}</div>
                <p className="range">
                  Estimated ± {estimate.uncertainty} min · opener {targetWeight}
                </p>
                <div className="stats">
                  <div>
                    <strong>{estimate.attempts}</strong>
                    <span>attempts ahead</span>
                  </div>
                  <div>
                    <strong>{estimate.flightBreaks}</strong>
                    <span>flight breaks</span>
                  </div>
                  <div>
                    <strong>{estimate.liftBreaks}</strong>
                    <span>lift breaks</span>
                  </div>
                </div>
              </>
            ) : estimate?.state === "complete" ? (
              <div className="state-message">
                <strong>Attempt complete</strong>
                <span>
                  {estimate.at
                    ? `Result recorded ${formatTime(estimate.at)}`
                    : "Result recorded"}{" "}
                  · {targetWeight}
                </span>
              </div>
            ) : estimate?.state === "passed" ? (
              <div className="state-message">
                <strong>Attempt has passed</strong>
                <span>The live platform is later in the lifting order.</span>
              </div>
            ) : (
              <div className="state-message">
                <strong>Waiting for platform activity</strong>
                <span>
                  The forecast starts when LiftingCast reports a current or
                  completed attempt.
                </span>
              </div>
            )}
            <div className="later-lifts">
              {estimates
                ?.filter((item) => item.lift !== lift)
                .map((item) => (
                  <div className="later-lift" key={item.lift}>
                    <span>{item.lift[0].toUpperCase() + item.lift.slice(1)}</span>
                    <strong>
                      {item.state === "estimated"
                        ? formatTime(item.at)
                        : item.state === "complete"
                          ? "Done"
                          : item.state === "passed"
                            ? "Passed"
                            : "Waiting"}
                    </strong>
                  </div>
                ))}
            </div>
            <p className="updated">
              Later openers include {liftGapMinutes} min between squat, bench, and deadlift.
              Last sync {formatTime(updatedAt)}.
            </p>
          </div>

          <div className="card warmup-card">
            <div className="section-title">
              <div>
                <p className="eyebrow">Countdown plan</p>
                <h2>Warm-ups</h2>
              </div>
              <button
                className="add"
                onClick={() =>
                  setWarmups((items) => [
                    ...items,
                    { id: Date.now(), weight: "", gap: 5 },
                  ])
                }
              >
                + Add set
              </button>
            </div>
            <div className="warmup-head">
              <span>Load</span>
              <span>Time</span>
              <span>Gap after</span>
              <span />
            </div>
            {warmups.map((warmup) => {
              const scheduled = timeline.find((item) => item.id === warmup.id);
              return (
                <div className="warmup-row" key={warmup.id}>
                  <input
                    value={warmup.weight}
                    aria-label="Warm-up weight"
                    onChange={(event) =>
                      updateWarmup(warmup.id, { weight: event.target.value })
                    }
                  />
                  <strong>{scheduled ? formatTime(scheduled.at) : "—"}</strong>
                  <div className="input-suffix">
                    <input
                      type="number"
                      min="0"
                      max="60"
                      value={warmup.gap}
                      onChange={(event) =>
                        updateWarmup(warmup.id, { gap: +event.target.value })
                      }
                    />
                    <span>min</span>
                  </div>
                  <button
                    aria-label="Remove warm-up"
                    className="remove"
                    onClick={() =>
                      setWarmups((items) =>
                        items.filter((item) => item.id !== warmup.id),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="attempt-row">
              <span>1st attempt · {targetWeight}</span>
              <strong>
                {estimate?.state === "estimated" ? formatTime(estimate.at) : "—"}
              </strong>
            </div>
          </div>
        </section>
          </>
        )}

        <p className="disclaimer">
          Planning aid only. Stay aware of the marshal and platform. Estimates
          can shift with jury decisions, clock resets, scratches, and
          unannounced breaks.
        </p>
      </div>
    </main>
  );
}
