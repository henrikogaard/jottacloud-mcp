import {
  acceptedContent,
  inputRequired,
  MissingRequiredClientCapabilityError,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const loginFields = z.object({
  personal_login_token: z.string().min(1),
});

const loginMessage =
  "Paste your Jottacloud personal login token from https://www.jottacloud.com/web/secure. It is exchanged for local refresh tokens. Do not paste it into chat.";

const requestedSchema = {
  type: "object" as const,
  properties: {
    personal_login_token: {
      type: "string" as const,
      title: "Personal login token",
      description: "One-shot token from jottacloud.com/web/secure",
    },
  },
  required: ["personal_login_token"],
};

export const envLoginHint =
  "This host cannot prompt privately for a token. Set JOTTACLOUD_LOGIN_TOKEN, or run: JOTTACLOUD_LOGIN_TOKEN='…' node dist/index.js --login";

export type LoginAsk =
  | { token: string }
  | { inputRequired: ReturnType<typeof inputRequired> }
  | { error: string };

export async function askLoginToken(ctx: ServerContext): Promise<LoginAsk> {
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, "login", loginFields);
  if (accepted?.personal_login_token) {
    return { token: accepted.personal_login_token };
  }

  try {
    const result = await ctx.mcpReq.elicitInput({
      message: loginMessage,
      requestedSchema,
    });
    if (result.action !== "accept") {
      return { error: "Login cancelled" };
    }
    const parsed = loginFields.safeParse(result.content);
    if (!parsed.success) {
      return { error: "Login form did not include a personal login token" };
    }
    return { token: parsed.data.personal_login_token };
  } catch (err) {
    if (err instanceof MissingRequiredClientCapabilityError) {
      return { error: envLoginHint };
    }
    return {
      inputRequired: inputRequired({
        inputRequests: {
          login: inputRequired.elicit({
            message: loginMessage,
            requestedSchema,
          }),
        },
      }),
    };
  }
}
