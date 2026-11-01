import type { Role } from "@vetledger/shared";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; clinicId: string; role: Role };
    }
  }
}
export {};
