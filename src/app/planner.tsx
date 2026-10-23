"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Board from "./board";

type Doc = Record<string, unknown> & { _id?: string };
type Warmup = { id: number; weight: string; gap: number };
type ApiDoc = { id: string; deleted: boolean; doc?: Doc };

const LIFTS = ["squat", "bench", "deadlift"];
type ListedMeet = { id: string; name: string; date: string };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const canonicalLift = (value: unknown) => {
  const name = text(value);
  return name === "dead" ? "deadlift" : name;
};
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

function meetDay(value: string) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function scheduledStart(day: string, time: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  const parts = day.split("-").map(Number);
  if (!match || parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const stamp = new Date(
    parts[0],
    parts[1] - 1,
    parts[2],
    Number(match[1]),
    Number(match[2]),
    0,
    0,
  ).getTime();
  return Number.isNaN(stamp) ? null : stamp;
}

function attemptLabel(round: number | undefined) {
  return round === 2 ? "2nd attempt" : round === 3 ? "3rd attempt" : "opener";
}

function extractMeetId(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "demo") return "demo";
  const match = trimmed.match(/(?:meets\/)?([a-z0-9]{12})(?:\/|$)/);
  return match?.[1] ?? "";
}

export default function Planner() {
  const [meetInput, setMeetInput] = useState("");
  const [meetId, setMeetId] = useState("");
  const [docs, setDocs] = useState<Map<string, Doc>>(new Map());
  const [sequence, setSequence] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "error">("idle");
  const [catalog, setCatalog] = useState<ListedMeet[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [today, setToday] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [lifterId, setLifterId] = useState("");
  const [lift, setLift] = useState("squat");
  const [pace, setPace] = useState(60);
  const [liftGapMinutes, setLiftGapMinutes] = useState(10);
  const [squatStarts, setSquatStarts] = useState<Record<string, string>>({});
  const [feedKey, setFeedKey] = useState(0);
  const [view, setView] = useState<"planner" | "board">("planner");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [warmups, setWarmups] = useState<Warmup[]>([
    { id: 1, weight: "Bar", gap: 5 },
    { id: 2, weight: "60", gap: 5 },
    { id: 3, weight: "100", gap: 5 },
    { id: 4, weight: "130", gap: 8 },
  ]);
  const docsRef = useRef(docs);
  const sequenceRef = useRef(sequence);
  const skipRef = useRef(0);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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
        if (typeof value.pace === "number" && value.pace !== 75) setPace(value.pace);
        if (value.liftGapMinutes) setLiftGapMinutes(value.liftGapMinutes);
        if (value.squatStarts && typeof value.squatStarts === "object") {
          setSquatStarts(value.squatStarts);
        }
      });
    } catch {
      // Ignore stale local data.
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    queueMicrotask(() => {
      const now = new Date();
      setToday(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      );
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/meets")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load meets");
        if (!cancelled) setCatalog(data.meets ?? []);
      })
      .catch((reason) => {
        if (!cancelled) {
          setCatalog([]);
          setCatalogError(reason instanceof Error ? reason.message : "Could not load meets");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "platform-coacher-settings",
      JSON.stringify({ warmups, pace, liftGapMinutes, squatStarts }),
    );
  }, [warmups, pace, liftGapMinutes, squatStarts]);

  useEffect(() => {
    if (!meetId) return;
    let cancelled = false;
    const epoch = ++epochRef.current;
    skipRef.current = 0;
    const initialDocs = new Map<string, Doc>();
    docsRef.current = initialDocs;
    sequenceRef.current = "";
    queueMicrotask(() => {
      if (cancelled) return;
      setDocs(initialDocs);
      setSequence("");
      setStatus("loading");
      setAdvancing(false);
      setError("");
    });

    function applyFeed(data: { mode: string; sequence: string; docs: ApiDoc[] }) {
      const next = data.mode === "snapshot" ? new Map<string, Doc>() : new Map(docsRef.current);
      for (const item of data.docs) {
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
    }

    async function poll() {
      while (!cancelled) {
        const ticket = epochRef.current;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const params = new URLSearchParams({ meetId });
          if (sequenceRef.current) params.set("since", sequenceRef.current);
          if (meetId === "demo" && skipRef.current > 0) {
            params.set("skip", String(skipRef.current));
          }
          const response = await fetch(`/api/meet?${params}`, { signal: controller.signal });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "Could not load meet");
          if (cancelled) return;
          if (ticket !== epochRef.current) continue;
          applyFeed(data);
        } catch (reason) {
          if (cancelled) return;
          if (reason instanceof Error && reason.name === "AbortError") continue;
          if (ticket !== epochRef.current) continue;
          setStatus("error");
          setError(reason instanceof Error ? reason.message : "Connection failed");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (epochRef.current === epoch) abortRef.current?.abort();
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
    const declaredOpeners = new Set(
      model.attempts
        .filter(
          (item) =>
            lifterById.has(text(item.lifterId)) &&
            number(item.attemptNumber) === 1 &&
            typeof item.weight === "number" &&
            item.weight > 0,
        )
        .map((item) => `${text(item.lifterId)}:${canonicalLift(item.liftName)}`),
    );
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
                canonicalLift(item.liftName) === liftName &&
                number(item.attemptNumber) === round &&
                declaredOpeners.has(`${text(item.lifterId)}:${liftName}`)
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
    const liveAttemptId = text(platform?.currentAttemptId);
    const meetStarted =
      Boolean(liveAttemptId) || ordered.some((item) => item.result);
    const startMs = scheduledStart(
      meetDay(text(model.meet?.date)) || today,
      squatStarts[`${meetId}:${lifter.session ?? ""}`] ?? "",
    );
    let currentId = liveAttemptId;
    if (meetStarted && (!currentId || !ordered.some((item) => item._id === currentId))) {
      currentId =
        [...ordered].sort((a, b) => resultTime(b) - resultTime(a))[0]?._id ?? "";
    }
    const currentIndex = ordered.findIndex((item) => item._id === currentId);

    return LIFTS.map((liftName) => {
      const rounds = [1, 2, 3].map((round) =>
        model.attempts.find(
          (item) =>
            item.lifterId === activeLifterId &&
            canonicalLift(item.liftName) === liftName &&
            number(item.attemptNumber) === round,
        ),
      );
      const opener = rounds[0];
      if (!opener) return { lift: liftName, state: "unavailable" as const };
      if (typeof opener.weight !== "number" || opener.weight <= 0) {
        return { lift: liftName, state: "unavailable" as const };
      }
      const pendingIndex = rounds.findIndex((attempt) => !attempt?.result);
      if (pendingIndex === -1) {
        const last = rounds[rounds.length - 1];
        return {
          lift: liftName,
          state: "complete" as const,
          round: 3,
          target: last,
          at: last && resultTime(last) ? new Date(resultTime(last)) : null,
        };
      }
      const round = pendingIndex + 1;
      const target = rounds[pendingIndex];
      if (!target) return { lift: liftName, state: "unavailable" as const, round };
      if (round > 1 && (typeof target.weight !== "number" || target.weight <= 0)) {
        return { lift: liftName, state: "unavailable" as const, round };
      }
      const targetIndex = ordered.findIndex((item) => item._id === target._id);
      if (!meetStarted) {
        if (startMs == null) {
          return { lift: liftName, state: "unscheduled" as const, round, target };
        }
        if (targetIndex < 0) return { lift: liftName, state: "waiting" as const, round, target };
        let liftBreaks = 0;
        for (let index = 1; index <= targetIndex; index++) {
          if (
            canonicalLift(ordered[index]?.liftName) !==
            canonicalLift(ordered[index - 1]?.liftName)
          ) {
            liftBreaks++;
          }
        }
        const seconds = targetIndex * pace + liftBreaks * liftGapMinutes * 60;
        return {
          lift: liftName,
          state: "estimated" as const,
          round,
          target,
          at: new Date(startMs + seconds * 1000),
          attempts: targetIndex,
          liftBreaks,
          uncertainty: Math.max(2, Math.ceil((targetIndex * 10) / 60 + liftBreaks * 3)),
        };
      }
      if (targetIndex < 0 || currentIndex < 0) {
        return { lift: liftName, state: "waiting" as const, round, target };
      }
      if (targetIndex <= currentIndex) {
        return { lift: liftName, state: "passed" as const, round, target };
      }

      const ahead = ordered.slice(currentIndex + 1, targetIndex + 1);
      let liftBreaks = 0;
      let previous = ordered[currentIndex];
      for (const attempt of ahead) {
        if (canonicalLift(attempt.liftName) !== canonicalLift(previous.liftName)) liftBreaks++;
        previous = attempt;
      }
      const seconds = ahead.length * pace + liftBreaks * liftGapMinutes * 60;
      return {
        lift: liftName,
        state: "estimated" as const,
        round,
        target,
        at: new Date((updatedAt?.getTime() ?? 0) + seconds * 1000),
        attempts: ahead.length,
        liftBreaks,
        uncertainty: Math.max(2, Math.ceil((ahead.length * 10) / 60 + liftBreaks * 3)),
      };
    });
  }, [model, activeLifterId, pace, liftGapMinutes, updatedAt, squatStarts, today, meetId]);

  const estimate = estimates?.find((item) => item.lift === lift) ?? null;
  const planEstimate =
    estimate?.state === "estimated"
      ? estimate
      : (estimates
          ?.slice(Math.max(LIFTS.indexOf(lift), 0))
          .find((item) => item.state === "estimated") ?? null);

  const timeline = useMemo(() => {
    if (planEstimate?.state !== "estimated") return [];
    let cursor = planEstimate.at.getTime();
    return [...warmups]
      .reverse()
      .map((warmup) => {
        cursor -= warmup.gap * 60_000;
        return { ...warmup, at: new Date(cursor) };
      })
      .reverse();
  }, [planEstimate, warmups]);

  async function fastForward() {
    if (meetId !== "demo" || advancing) return;
    const ticket = ++epochRef.current;
    setAdvancing(true);
    try {
      const params = new URLSearchParams({ meetId: "demo", advance: "1" });
      if (sequenceRef.current) params.set("since", sequenceRef.current);
      if (skipRef.current > 0) params.set("skip", String(skipRef.current));
      const response = await fetch(`/api/meet?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not fast-forward");
      if (ticket !== epochRef.current) return;
      skipRef.current = typeof data.skip === "number" ? data.skip : skipRef.current;
      const next = data.mode === "snapshot" ? new Map<string, Doc>() : new Map(docsRef.current);
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
      abortRef.current?.abort();
    } catch (reason) {
      if (ticket !== epochRef.current) return;
      setError(reason instanceof Error ? reason.message : "Could not fast-forward");
    } finally {
      if (ticket === epochRef.current) setAdvancing(false);
    }
  }

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

  function chooseMeet(id: string) {
    setLifterId("");
    setMeetInput(id);
    setMeetId(id);
    setError("");
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

  const todayMeets = (catalog ?? []).filter((meet) => meetDay(meet.date) === today);
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
  const latestResult = platformAttempts
    .filter((attempt) => attempt.result)
    .sort((a, b) => resultTime(b) - resultTime(a))[0];
  const latestResultLifter = model.lifters.find((item) => item._id === latestResult?.lifterId);
  const nextLift = LIFTS.find((liftName) =>
    platformAttempts.some(
      (attempt) => !attempt.result && canonicalLift(attempt.liftName) === liftName,
    ),
  );
  const liveFlight =
    text(currentLifter?.flight) ||
    text(latestResultLifter?.flight) ||
    text(selectedLifter?.flight);
  const squatStartKey = `${meetId}:${selectedLifter?.session ?? ""}`;
  const squatStart = squatStarts[squatStartKey] ?? "";
  const squatStartMs = scheduledStart(meetDay(text(model.meet?.date)) || today, squatStart);
  const platformLive =
    Boolean(text(activePlatform?.currentAttemptId)) ||
    platformAttempts.some((attempt) => attempt.result);
  const barStatus = currentLifter
    ? `On the bar · ${text(currentLifter.name)} · Flight ${text(currentLifter.flight)} · ${canonicalLift(currentAttempt?.liftName)} ${text(currentAttempt?.attemptNumber)} · ${number(currentAttempt?.weight)} ${text(model.meet?.units).toLowerCase()}`
    : platformAttempts.length > 0 && platformAttempts.every((item) => item.result)
      ? "Platform finished"
      : latestResult && nextLift && canonicalLift(latestResult.liftName) !== nextLift
        ? "Lift break"
        : platformAttempts.some((item) => item.result)
          ? "Waiting for the next attempt"
          : squatStartMs != null && !platformLive
            ? `Squats start ${formatTime(new Date(squatStartMs))}`
            : "Waiting for the platform";
  const estimateTarget =
    estimate && "target" in estimate ? estimate.target : undefined;
  const targetWeight =
    estimateTarget && typeof estimateTarget.weight === "number"
      ? `${estimateTarget.weight} ${text(model.meet?.units).toLowerCase()}`
      : "not declared";
  const planTarget =
    planEstimate && "target" in planEstimate ? planEstimate.target : undefined;
  const planWeight =
    planTarget && typeof planTarget.weight === "number"
      ? `${planTarget.weight} ${text(model.meet?.units).toLowerCase()}`
      : "not declared";
  const planLiftName = planEstimate?.lift ?? lift;
  const planLiftLabel = planLiftName[0].toUpperCase() + planLiftName.slice(1);
  const planRound = planEstimate && "round" in planEstimate ? planEstimate.round : undefined;
  const planAttemptLabel = attemptLabel(planRound);

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span>PC</span> Platform Coacher
        </div>
        <div className="top-actions">
          {meetId === "demo" && (
            <button
              type="button"
              className="fast-forward"
              disabled={advancing}
              onClick={() => void fastForward()}
            >
              Fast-forward
            </button>
          )}
          {meetId && (
            <div className={`connection ${status}`}>
              <i />{" "}
              {status === "live"
                ? "Live"
                : status === "loading"
                  ? "Connecting"
                  : "Offline"}
            </div>
          )}
          <button
            type="button"
            className="gear"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.4 13.5a7.7 7.7 0 0 0 .1-1.5 7.7 7.7 0 0 0-.1-1.5l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.4 7.4 0 0 0-2.6-1.5l-.4-2.5a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.5a7.4 7.4 0 0 0-2.6 1.5l-2.4-1a.5.5 0 0 0-.6.2L2.4 8.3a.5.5 0 0 0 .1.6l2 1.6a7.7 7.7 0 0 0-.1 1.5 7.7 7.7 0 0 0 .1 1.5l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3a.5.5 0 0 0 .6.2l2.4-1a7.4 7.4 0 0 0 2.6 1.5l.4 2.5a.5.5 0 0 0 .5.4h3.8a.5.5 0 0 0 .5-.4l.4-2.5a7.4 7.4 0 0 0 2.6-1.5l2.4 1a.5.5 0 0 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6l-2-1.6ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"
              />
            </svg>
          </button>
        </div>
      </header>
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="remove"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="demo-note">
              The demo is a simulated platform. Most attempts take 5 seconds, with
              a slow attempt, lift breaks, a weight change, and a scratch.
            </p>
            <button
              type="button"
              className="demo-action"
              onClick={() => {
                setSettingsOpen(false);
                void watchDemo();
              }}
            >
              {meetId === "demo" ? "Restart demo" : "Watch demo"}
            </button>
          </div>
        </div>
      )}

      <div className="shell">
        <section className="hero">
          <p className="eyebrow">LiftingCast warm-up planner</p>
          <h1>
            {meetId
              ? text(model.meet?.name) || "Loading meet"
              : "Meets today"}
          </h1>
          <p className="subhead">
            {meetId
              ? "Live attempt order becomes a warm-up schedule for your lifter."
              : "Choose a meet dated today, or paste a LiftingCast link."}
          </p>
          <form className="meet-form" onSubmit={loadMeet}>
            <input
              aria-label="Meet URL or ID"
              value={meetInput}
              onChange={(event) => setMeetInput(event.target.value)}
              placeholder="LiftingCast meet URL or ID"
            />
            <button>Load meet</button>
          </form>
          {meetId && (
            <button type="button" className="text-button" onClick={() => chooseMeet("")}>
              Back to the meet list
            </button>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        {!meetId && (
          <section className="card meet-list">
            {(catalog === null || !today) && <p>Loading meets…</p>}
            {catalogError && <p className="error">{catalogError}</p>}
            {catalog !== null && today && !catalogError && todayMeets.length === 0 && (
              <p>No LiftingCast meets are dated today.</p>
            )}
            {todayMeets.map((meet) => (
              <button
                key={meet.id}
                type="button"
                className="meet-choice"
                onClick={() => chooseMeet(meet.id)}
              >
                <strong>{meet.name}</strong>
                <span>{meet.date}</span>
              </button>
            ))}
          </section>
        )}

        {meetId && (
        <>
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
            Squats start
            <input
              type="time"
              value={squatStart}
              onChange={(event) => {
                const value = event.target.value;
                setSquatStarts((current) => ({ ...current, [squatStartKey]: value }));
              }}
            />
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
                <p className="eyebrow">
                  {planEstimate?.state === "estimated"
                    ? `${planLiftLabel} forecast`
                    : "First attempt forecast"}
                </p>
                <h2>
                  {selectedLifter ? text(selectedLifter.name) : "Select a lifter"}
                </h2>
              </div>
              <span className="flight">
                Flight {liveFlight || "—"}
              </span>
            </div>
            <p className="bar-status">{barStatus}</p>

            {planEstimate?.state === "estimated" ? (
              <>
                <div className="big-time">{formatTime(planEstimate.at)}</div>
                <p className="range">
                  Estimated ± {planEstimate.uncertainty} min · {planLiftLabel}{" "}
                  {planAttemptLabel} {planWeight}
                </p>
                <div className="stats">
                  <div>
                    <strong>{planEstimate.attempts}</strong>
                    <span>attempts ahead</span>
                  </div>
                  <div>
                    <strong>{planEstimate.liftBreaks}</strong>
                    <span>lift breaks</span>
                  </div>
                </div>
              </>
            ) : estimate?.state === "complete" ? (
              <div className="state-message">
                <strong>{lift[0].toUpperCase() + lift.slice(1)} finished</strong>
                <span>
                  {estimate.at
                    ? `Last result ${formatTime(estimate.at)}`
                    : "Last result recorded"}{" "}
                  · {targetWeight}
                </span>
              </div>
            ) : estimate?.state === "passed" ? (
              <div className="state-message">
                <strong>Attempt has passed</strong>
                <span>The live platform is later in the lifting order.</span>
              </div>
            ) : estimate?.state === "unscheduled" ? (
              <div className="state-message">
                <strong>Set the squat start</strong>
                <span>
                  Enter when squats are scheduled to begin. Warm-ups count back
                  from that time until the platform goes live.
                </span>
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
                ?.filter((item) => item.lift !== planLiftName)
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
                            : item.state === "unscheduled"
                              ? "Set start"
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
                <h2>{planLiftLabel} warm-ups</h2>
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
              <span>
                {planLiftLabel} {planAttemptLabel} · {planWeight}
              </span>
              <strong>
                {planEstimate?.state === "estimated" ? formatTime(planEstimate.at) : "—"}
              </strong>
            </div>
          </div>
        </section>
          </>
        )}
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
