import { withOperator } from "@/lib/operator";

export const GET = withOperator((_request, _context, operator) => Response.json({ operator }));
