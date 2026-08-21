import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await query(
    `select distinct on (job_name)
            job_name, status, target_date::text, started_at::text, finished_at::text,
            rows_processed, error_message
     from data_sync_status
     order by job_name, started_at desc`,
  );

  return Response.json({ jobs });
}
