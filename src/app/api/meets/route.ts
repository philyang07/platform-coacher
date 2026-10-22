import { NextResponse } from "next/server";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

type ListedMeet = {
  _id?: string;
  name?: string;
  date?: string;
  showOnHomePage?: boolean;
};

export async function GET() {
  try {
    const response = await fetch("https://liftingcast.com/api/meets", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: `LiftingCast returned ${response.status}` },
        { status: response.status },
      );
    }

    const data = (await response.json()) as { docs?: ListedMeet[] };
    const meets = (data.docs ?? [])
      .filter((meet) => meet.showOnHomePage && meet._id && meet.name && meet.date)
      .map((meet) => ({
        id: meet._id as string,
        name: meet.name as string,
        date: meet.date as string,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ meets }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load meets";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
