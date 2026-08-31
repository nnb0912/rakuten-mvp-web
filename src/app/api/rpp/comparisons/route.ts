import { readRppComparison } from "@/lib/rppComparisons";
export const dynamic="force-dynamic"; export const runtime="nodejs";
export async function GET(request:Request){try{return Response.json(await readRppComparison(new URL(request.url).searchParams));}catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}}
