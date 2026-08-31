import { refreshSchema } from "@/lib/schemas";
import { findUser, issueAccessToken, verifyRefreshToken } from "@/lib/server/auth";
import { error, handle, json, parseBody } from "@/lib/server/http";

export async function POST(req: Request) {
  return handle(async () => {
    const { refreshToken } = await parseBody(req, refreshSchema);

    const userId = verifyRefreshToken(refreshToken);
    // Verifying the subject still exists matters: a token can outlive the account it names.
    if (!userId || !findUser(userId)) {
      return error(401, "Invalid or expired refresh token");
    }

    return json({ accessToken: issueAccessToken(userId) });
  });
}
