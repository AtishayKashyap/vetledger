import { AppError } from "./errors.js";

/**
 * Opaque keyset cursor over (created_at DESC, id DESC). Unlike OFFSET, cost doesn't
 * grow with page depth and rows inserted meanwhile can't shift or duplicate a page.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
    if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error();
    return { createdAt, id };
  } catch {
    throw new AppError(400, "Bad Request", "invalid cursor");
  }
}
