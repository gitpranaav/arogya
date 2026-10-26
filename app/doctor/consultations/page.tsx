import Link from "next/link";
import { ObjectId } from "mongodb";

import { Button } from "@/src/components/ui/Button";
import { Badge } from "@/src/components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Input } from "@/src/components/ui/Input";
import { getServerContext } from "@/src/lib/mongodb/server";

const PAGE_SIZE = 8;

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().trim();
}

function buildPageHref(q: string, page: number) {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/doctor/consultations?${query}` : "/doctor/consultations";
}

export default async function ConsultationsPage({ searchParams }: { searchParams?: Promise<{ q?: string; page?: string }> }) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const q = String(resolvedSearchParams.q ?? "").trim();
  const requestedPage = Number.parseInt(String(resolvedSearchParams.page ?? "1"), 10);
  const currentPageInput = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const { db, session } = await getServerContext();
  const rows = await db
    .collection("consultations")
    .find({ doctor_id: new ObjectId(session.uid) })
    .sort({ created_at: -1 })
    .toArray();
  const patientIds = rows.map((row) => row.patient_id).filter(Boolean);
  const consultationIds = rows.map((row) => row._id);
  const doctorObjectId = new ObjectId(session.uid);
  const [patients, emrEntries] = await Promise.all([
    patientIds.length ? db.collection("patients").find({ _id: { $in: patientIds } }).toArray() : [],
    consultationIds.length ? db.collection("emr_entries").find({ consultation_id: { $in: consultationIds } }).toArray() : [],
  ]);
  const patientMap = new Map(patients.map((patient) => [patient._id.toString(), patient]));
  const emrMap = new Map(emrEntries.map((entry) => [entry.consultation_id.toString(), entry]));

  const filteredRows = q
    ? rows.filter((row) => {
        const patient = patientMap.get(row.patient_id?.toString());
        const emrEntry = emrMap.get(row._id.toString());
        const haystack = [
          patient?.name,
          row.status,
          row.type,
          row.created_at,
          emrEntry?.chief_complaint,
          emrEntry?.clinical_summary,
          emrEntry?.patient_summary,
        ]
          .map(normalize)
          .join(" ");
        return haystack.includes(normalize(q));
      })
    : rows;

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(currentPageInput, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredRows.slice(start, start + PAGE_SIZE);
  const pageStart = filteredRows.length ? start + 1 : 0;
  const pageEnd = Math.min(start + PAGE_SIZE, filteredRows.length);

  const paginationWindow = Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
    const offset = index - 2;
    const candidate = currentPage + offset;
    return Math.min(totalPages, Math.max(1, candidate));
  }).filter((value, index, array) => array.indexOf(value) === index);

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Consultation History</CardTitle>
          <p className="text-xs text-[hsl(var(--text-muted))]">
            {filteredRows.length ? `${pageStart}-${pageEnd} of ${filteredRows.length}` : "No consultations found"}
          </p>
        </div>
        <form className="flex flex-col gap-2 sm:flex-row" method="get">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search patient, status, type, complaint..."
            className="sm:flex-1"
          />
          <input type="hidden" name="page" value="1" />
          <Button type="submit" variant="secondary" className="sm:w-auto">
            Search
          </Button>
          {q ? (
            <Link
              href="/doctor/consultations"
              className="inline-flex h-10 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-4 text-sm font-medium text-[hsl(var(--text-primary))] shadow-[var(--shadow-sm)] hover:bg-[hsl(var(--bg-secondary))]"
            >
              Clear
            </Link>
          ) : null}
        </form>
      </CardHeader>
      <CardContent className="space-y-2">
        {pageRows.map((row) => (
          <Link key={row._id.toString()} href={`/doctor/consultations/${row._id.toString()}`} className="block rounded-[var(--radius)] border border-[hsl(var(--border))] p-3 hover:bg-[hsl(var(--bg-secondary))]">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{patientMap.get(row.patient_id?.toString())?.name ?? "Unknown Patient"}</p>
              <Badge variant="outline">{row.status}</Badge>
            </div>
            <p className="text-xs text-[hsl(var(--text-muted))]">{new Date(row.created_at).toLocaleString("en-IN")} · {row.type ?? "General"}</p>
            <p className="text-sm">{emrMap.get(row._id.toString())?.chief_complaint ?? "No chief complaint"}</p>
          </Link>
        ))}
        {!pageRows.length ? (
          <div className="rounded-[var(--radius)] border border-dashed border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--text-muted))]">
            {q ? "No consultations match your search." : "No consultations found."}
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <Link
              href={buildPageHref(q, Math.max(1, currentPage - 1))}
              aria-disabled={currentPage === 1}
              className={currentPage === 1
                ? "pointer-events-none inline-flex h-9 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-3 text-sm text-[hsl(var(--text-muted))] opacity-60"
                : "inline-flex h-9 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-3 text-sm text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--bg-secondary))]"
              }
            >
              Previous
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              {paginationWindow.map((pageNumber) => (
                <Link
                  key={pageNumber}
                  href={buildPageHref(q, pageNumber)}
                  className={pageNumber === currentPage
                    ? "inline-flex h-9 min-w-9 items-center justify-center rounded-[calc(var(--radius)-2px)] bg-[hsl(var(--accent))] px-3 text-sm font-medium text-[hsl(var(--accent-fg))]"
                    : "inline-flex h-9 min-w-9 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-3 text-sm text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--bg-secondary))]"
                  }
                  aria-current={pageNumber === currentPage ? "page" : undefined}
                >
                  {pageNumber}
                </Link>
              ))}
            </div>
            <Link
              href={buildPageHref(q, Math.min(totalPages, currentPage + 1))}
              aria-disabled={currentPage === totalPages}
              className={currentPage === totalPages
                ? "pointer-events-none inline-flex h-9 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-3 text-sm text-[hsl(var(--text-muted))] opacity-60"
                : "inline-flex h-9 items-center justify-center rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-3 text-sm text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--bg-secondary))]"
              }
            >
              Next
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
