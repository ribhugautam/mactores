import { loginSchema } from "@/lib/schemas";
import { authenticate, issueTokens } from "@/lib/server/auth";
import { error, handle, json, parseBody } from "@/lib/server/http";

export async function POST(req: Request) {
  return handle(async () => {
    const { email, password } = await parseBody(req, loginSchema);

    const user = authenticate(email, password);
    // One message for both a wrong email and a wrong password, so the response can't be used to
    // enumerate accounts.
    if (!user) return error(401, "Invalid email or password");

    return json({ ...issueTokens(user.id), user });
  });
}
