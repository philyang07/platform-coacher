"use client";

import { useState } from "react";

type Doc = Record<string, unknown> & { _id?: string };

const LIFTS = ["squat", "bench", "deadlift"];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) =>
  typeof value === "number" ? value : Number(value) || 0;

type AttemptCell = {
  id: string;
  weight: number | null;
  result: string;
};

export default function Board({
  lifters,
  attempts,
  platforms,
  currentAttempt,
  units,
  selectedLifterId,
  onSelectLifter,
}: {
  lifters: Doc[];
  attempts: Doc[];
  platforms: Doc[];
  currentAttempt?: Doc;
  units: string;
  selectedLifterId: string;
  onSelectLifter: (id: string) => void;
}) {
  const [pinnedLift, setPinnedLift] = useState<string | null>(null);
  const liveLift = text(currentAttempt?.liftName);
  const lift = pinnedLift ?? (liveLift || "squat");
  const currentId = text(currentAttempt?._id);
  const platformIds = [...new Set(lifters.map((lifter) => text(lifter.platformId)))];

  return (
    <section className="card board">
      <div className="section-title">
        <div>
          <p className="eyebrow">Live board</p>
          <h2>{lift[0].toUpperCase() + lift.slice(1)}</h2>
        </div>
        <div className="lift-tabs">
          {LIFTS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={lift === item}
              onClick={() => setPinnedLift(item === liveLift ? null : item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {pinnedLift && (
        <button type="button" className="follow" onClick={() => setPinnedLift(null)}>
          Follow the platform
        </button>
      )}

      {platformIds.map((platformId) => {
        const platform = platforms.find((item) => item._id === platformId);
        const platformLifters = lifters.filter((lifter) => lifter.platformId === platformId);
        const flights = [...new Set(platformLifters.map((lifter) => text(lifter.flight)))].sort();
        const grouped = flights.map((flight) => ({
          flight,
          rows: platformLifters
            .filter((lifter) => text(lifter.flight) === flight)
            .map((lifter) => ({
              id: text(lifter._id),
              name: text(lifter.name),
              lot: number(lifter.lot),
              attempts: [1, 2, 3].map((round) => {
                const attempt = attempts.find(
                  (item) =>
                    item.lifterId === lifter._id &&
                    item.liftName === lift &&
                    number(item.attemptNumber) === round,
                );
                return {
                  id: text(attempt?._id),
                  weight: typeof attempt?.weight === "number" ? attempt.weight : null,
                  result: text(attempt?.result),
                } satisfies AttemptCell;
              }),
            }))
            .sort(
              (a, b) =>
                (a.attempts[0]?.weight ?? Number.POSITIVE_INFINITY) -
                  (b.attempts[0]?.weight ?? Number.POSITIVE_INFINITY) || a.lot - b.lot,
            ),
        }));
        const ordered = grouped.flatMap((group) =>
          [1, 2, 3].flatMap((round) =>
            [...group.rows]
              .filter((row) => row.attempts[round - 1]?.id)
              .sort(
                (a, b) =>
                  (a.attempts[round - 1]?.weight ?? Number.POSITIVE_INFINITY) -
                    (b.attempts[round - 1]?.weight ?? Number.POSITIVE_INFINITY) ||
                  a.lot - b.lot,
              )
              .map((row) => row.attempts[round - 1]),
          ),
        );
        const pending = ordered.filter((attempt) => attempt?.id && !attempt.result);
        const nextId =
          currentId && pending[0]?.id === currentId ? pending[1]?.id : pending[0]?.id;

        return (
          <div key={platformId} className="platform-block">
            {platformIds.length > 1 && <h3>Platform {text(platform?.name) || platformId}</h3>}
            {grouped.map((group) => (
              <div key={group.flight} className="flight-block">
                <div className="flight-title">
                  <h3>Flight {group.flight}</h3>
                  <span>{group.rows.length} lifters</span>
                </div>
                <div className="board-scroll">
                  <table className="board-table">
                    <thead>
                      <tr>
                        <th>Lifter</th>
                        <th>Lot</th>
                        <th>1st</th>
                        <th>2nd</th>
                        <th>3rd</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr
                          key={row.id}
                          className={
                            row.attempts.some((attempt) => attempt.id === currentId)
                              ? "on-bar"
                              : row.id === selectedLifterId
                                ? "selected"
                                : undefined
                          }
                        >
                          <td>
                            <button type="button" onClick={() => onSelectLifter(row.id)}>
                              {row.name}
                            </button>
                          </td>
                          <td className="lot">{row.lot || "—"}</td>
                          {row.attempts.map((attempt, index) => (
                            <td key={`${row.id}-${index}`}>
                              <span
                                className={`attempt-chip ${
                                  attempt.id && attempt.id === currentId
                                    ? "current"
                                    : attempt.id === nextId
                                      ? "next"
                                      : attempt.result
                                }`}
                              >
                                {attempt.weight === null ? "—" : `${attempt.weight} ${units}`}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <p className="updated">Select a lifter to use them in the planner.</p>
    </section>
  );
}
