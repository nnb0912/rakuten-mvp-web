import { readRppComparison } from "@/lib/rppComparisons";
import { requireRppRole } from "@/lib/rppRouteAuth";
export const dynamic="force-dynamic"; export const runtime="nodejs";
export async function GET(request:Request){const access=await requireRppRole("viewer");if(!access.ok)return access.response;try{return Response.json(await readRppComparison(new URL(request.url).searchParams));}catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}}
