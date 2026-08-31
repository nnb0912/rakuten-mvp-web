import{auth}from"@/auth";import{readRppStrategySettings,writeRppStrategySettings,type RppStrategySettings}from"@/lib/rppStrategySettings";
export const dynamic="force-dynamic";export const runtime="nodejs";
export async function GET(){return Response.json(await readRppStrategySettings())}
export async function POST(request:Request){const session=await auth();if(!session?.user?.email)return Response.json({error:"unauthorized"},{status:401});try{return Response.json({ok:true,...await writeRppStrategySettings(await request.json()as Partial<RppStrategySettings>,session.user.email)})}catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}}
